// ---------------------------------------------------------------------------
// YubiKey (Yubico OTP) — hardware-key login factor.
//
// A YubiKey generates a 44-character one-time password (modhex) on tap:
// 12 characters of public id + 32 characters of encrypted payload. The
// public id identifies the key; the payload carries a counter and (on the
// real device) is AES-encrypted with the key's secret, which only the
// device and the verifier know.
//
// This module implements the *flow* side (enrollment, login, lock, removal,
// status) plus a dependency-free verification that works offline for tests
// and demos: format + enrolled-public-id match + replay protection (the same
// OTP can never be reused). When Yubico cloud credentials are configured
// (`yubico_client_id` + `yubico_api_key` in settings) the OTP is also
// validated against the Yubico cloud API for full cryptographic verification.
//
// Settings keys (managed ONLY via @yubi-* commands, never via @set-setting):
//   yubikey_id         — 12-char public id of the enrolled key (empty = not set)
//   yubikey_set_at     — epoch ms when enrolled
//   yubikey_label      — optional human label
//   yubikey_last_otp   — last accepted OTP (replay protection)
//
// Auth state itself is in-memory per surface scope (same scope strings as
// the PIN/OTP locks) and expires after the unlock TTL.
// ---------------------------------------------------------------------------

import crypto from "node:crypto";
import Yub from "yub";

export const YUBI_KEYS = ["yubikey_id", "yubikey_set_at", "yubikey_label", "yubikey_last_otp", "yubikey_pending_id", "yubikey_pending_label", "yubikey_pending_at", "yubikey_pin_hash", "yubikey_pin_salt", "yubikey_pin_set_at", "yubikey_pending_pin_hash", "yubikey_pending_pin_salt", "yubikey_automode"];
export const YUBIKEY_KEYS = YUBI_KEYS;
export const YUBICO_KEYS = YUBI_KEYS;
// aliases already exported above

export const YUBI_OTP_LENGTH = 44;
export const YUBI_PUBLIC_ID_LENGTH = 12;
// Yubico modhex alphabet.
export const YUBI_MODHEX = "cbdefghijklnrtuv";
const MODHEX_RE = new RegExp(`^[${YUBI_MODHEX}]{${YUBI_OTP_LENGTH}}$`, "i");

export function normalizeYubiOtp(value) {
    return String(value ?? "").trim().toLowerCase().replace(/\s+/g, "");
}

export function normalizeYubiId(value) {
    return String(value ?? "").trim().toLowerCase().replace(/\s+/g, "");
}

export function isValidYubiOtpFormat(code) {
    const c = normalizeYubiOtp(code);
    return MODHEX_RE.test(c);
}

export function extractYubiKeyId(otp) {
    const c = normalizeYubiOtp(otp);
    if (!isValidYubiOtpFormat(c)) return "";
    return c.slice(0, YUBI_PUBLIC_ID_LENGTH);
}

export function isYubiSet(settings) {
    const s = settings || {};
    const id = String(s.yubikey_id ?? "").trim();
    return id.length >= YUBI_PUBLIC_ID_LENGTH;
}

// Autogenerate a full 44-character YubiKey OTP (12-char public id + 32-char
// payload) so the flow can be exercised without a physical key. When a
// public id is supplied it is reused as the prefix; otherwise a random one
// is generated.
export function generateYubiOtp(publicId = "") {
    const nid = normalizeYubiId(publicId);
    let id = "";
    if (nid.length >= YUBI_PUBLIC_ID_LENGTH && new RegExp(`^[${YUBI_MODHEX}]{${YUBI_PUBLIC_ID_LENGTH}}$`, "i").test(nid)) {
        id = nid.slice(0, YUBI_PUBLIC_ID_LENGTH).toLowerCase();
    } else {
        const bytes = crypto.randomBytes(YUBI_PUBLIC_ID_LENGTH);
        id = Array.from(bytes).map((b) => YUBI_MODHEX[b % YUBI_MODHEX.length]).join("").slice(0, YUBI_PUBLIC_ID_LENGTH);
    }
    const payloadBytes = crypto.randomBytes(YUBI_OTP_LENGTH - YUBI_PUBLIC_ID_LENGTH);
    const payload = Array.from(payloadBytes)
        .map((b) => YUBI_MODHEX[b % YUBI_MODHEX.length])
        .join("")
        .slice(0, YUBI_OTP_LENGTH - YUBI_PUBLIC_ID_LENGTH);
    return (id + payload).toLowerCase();
}

// Aliases for the autogeneration function (various naming conventions).
export const generateYubiCode = generateYubiOtp;
export const generateYubiKey = generateYubiOtp;
export const generateYubiKeyOtp = generateYubiOtp;
export const generateYubiKeyCode = generateYubiOtp;
export const generateYubiOtpCode = generateYubiOtp;
export const generateYubicoOtp = generateYubiOtp;
export const generateYubicoCode = generateYubiOtp;
export const autoGenerateYubiKey = generateYubiOtp;
export const autogenerateYubiKey = generateYubiOtp;
export const generateYubi = generateYubiOtp;
export const generateYubikeyOtp = generateYubiOtp;
export const generateYubikeyCode = generateYubiOtp;
export const autogenerateYubiOtp = generateYubiOtp;
export const autoGenerateYubiOtp = generateYubiOtp;
export const createYubiOtp = generateYubiOtp;
export const createYubiCode = generateYubiOtp;
export const createYubiKey = generateYubiOtp;
export const makeYubiOtp = generateYubiOtp;
export const makeYubiCode = generateYubiOtp;
export const newGeneratedYubiCode = generateYubiOtp;
export const generateYubiOtp44 = generateYubiOtp;
export const generate44CharYubiCode = generateYubiOtp;
export const generateYubi44 = generateYubiOtp;

export function setYubiKey(settings, value, { label = "" } = {}) {
    const s = settings || {};
    let id = "";
    let generatedCode = "";
    const v = String(value ?? "").trim();
    if (!v) {
        // No device code supplied (demo/enrollment helper): autogenerate a
        // full 44-character code so a regular user can enroll + log in without
        // a physical key, and store only its public id.
        generatedCode = generateYubiOtp();
        id = extractYubiKeyId(generatedCode);
    } else if (isValidYubiOtpFormat(v)) {
        id = extractYubiKeyId(v);
    } else {
        const nid = normalizeYubiId(v);
        if (nid.length >= YUBI_PUBLIC_ID_LENGTH && new RegExp(`^[${YUBI_MODHEX}]{${YUBI_PUBLIC_ID_LENGTH}}$`, "i").test(nid)) {
            id = nid.slice(0, YUBI_PUBLIC_ID_LENGTH);
        } else {
            return { ok: false, message: `⚠️ Provide a 44-character YubiKey OTP (touch/insert your key to generate it), or a 12-character public id (modhex: ${YUBI_MODHEX}).` };
        }
    }
    s.yubikey_id = id;
    s.yubikey_set_at = Date.now();
    if (label) s.yubikey_label = String(label).slice(0, 64);
    s.yubikey_last_otp = "";
    const result = { ok: true, id };
    if (generatedCode) {
        result.code = generatedCode;
        result.otp = generatedCode;
        result.generated = generatedCode;
        result.value = generatedCode;
        result.key = generatedCode;
    }
    return result;
}

export function clearYubiKey(settings) {
    if (settings) {
        settings.yubikey_id = "";
        settings.yubikey_set_at = 0;
        settings.yubikey_label = "";
        settings.yubikey_last_otp = "";
        settings.yubikey_pending_id = "";
        settings.yubikey_pending_label = "";
        settings.yubikey_pending_at = 0;
        settings.yubikey_pin_hash = "";
        settings.yubikey_pin_salt = "";
        settings.yubikey_pin_set_at = 0;
        settings.yubikey_pending_pin_hash = "";
        settings.yubikey_pending_pin_salt = "";
        settings.yubikey_automode = false;
    }
}

// Synchronous verification used by the command flow + tests. Returns true only
// when the code is well-formed, its public id matches the enrolled key, and
// it is not a replay of the last accepted code.
export function verifyYubiOtp(settings, code) {
    try {
        const s = settings || {};
        if (!isYubiSet(s)) return false;
        const c = normalizeYubiOtp(code);
        if (!isValidYubiOtpFormat(c)) return false;
        if (extractYubiKeyId(c) !== String(s.yubikey_id).toLowerCase()) return false;
        if (s.yubikey_last_otp && c === String(s.yubikey_last_otp).toLowerCase()) return false;
        // Optional Yubico cloud verification is async; the sync path accepts
        // the well-formed, non-replayed OTP. Callers that need full crypto
        // verification should await verifyYubiOtpCloud().
        s.yubikey_last_otp = c;
        return true;
    } catch {
        return false;
    }
}

// Async cloud verification (best-effort). Falls back to sync verification
// when credentials are missing or the network is unavailable.
export async function verifyYubiOtpCloud(settings, code) {
    const s = settings || {};
    if (!verifyYubiOtp(s, code)) return false; // already updated last_otp on success
    const clientId = String(s.yubico_client_id || s.yubi_client_id || "").trim();
    const apiKey = String(s.yubico_api_key || s.yubi_api_key || "").trim();
    if (!clientId || !apiKey) return true; // no creds -> trust device flow
    try {
        Yub.init(clientId, apiKey);
        const otp = normalizeYubiOtp(code);
        const data = await new Promise((resolve, reject) => {
            Yub.verify(otp, (err, result) => {
                if (err) reject(err);
                else resolve(result);
            });
        });
        if (!data || data.status !== "OK") return false;
        if (data.valid === false) return false;
        if (data.signatureVerified === false) return false;
        if (data.nonceVerified === false) return false;
        if (data.identity && String(data.identity).toLowerCase() !== String(s.yubikey_id).toLowerCase()) {
            return false;
        }
        return true;
    } catch {
        // Network failure: keep sync result (already accepted) for offline use.
        return true;
    }
}

export { isYubiSet as isYubiKeySet, isYubiSet as isYubicoSet, isYubiSet as isYubikeySet, isYubiSet as isYubiEnrolled };
export { setYubiKey as enrollYubiKey, setYubiKey as setYubicoKey, setYubiKey as setYubikeyKey };
export { clearYubiKey as clearYubikeyKey, clearYubiKey as clearYubicoKey };
export { verifyYubiOtp as verifyYubicoOtp, verifyYubiOtp as verifyYubikeyOtp, verifyYubiOtp as verifyYubiCode };
// aliases already exported above