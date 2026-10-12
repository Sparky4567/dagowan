// ---------------------------------------------------------------------------
// OTP (TOTP / Google Authenticator) — second factor in front of the PIN lock.
//
// Standard RFC 6238 TOTP (SHA-1, 30s period, 6 digits), compatible with
// Google Authenticator, Authy, 1Password, etc. No external dependency —
// implemented on top of node:crypto so it works fully offline.
//
// Settings keys (managed ONLY via @otp-* commands, never via @set-setting):
//   otp_secret  — base32 TOTP secret (empty = OTP not set)
//   otp_set_at  — epoch ms when the secret was enrolled
//   otp_account — label shown in the authenticator app
//   otp_issuer  — issuer shown in the authenticator app
//
// Auth state itself is in-memory per surface scope (same scope strings as
// the PIN lock) and expires after the unlock TTL.
// ---------------------------------------------------------------------------

import crypto from "node:crypto";

export const OTP_KEYS = ["otp_secret", "otp_set_at", "otp_account", "otp_issuer"];
export const OTP_DIGITS = 6;
export const OTP_PERIOD_SECONDS = 30;
export const OTP_WINDOW = 1; // accept ±1 step for clock skew
export const OTP_SECRET_BYTES = 20; // 160 bits -> 32 base32 chars

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

// --- base32 ---------------------------------------------------------------

export function base32Encode(bytes) {
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    let bits = 0;
    let value = 0;
    let out = "";
    for (const byte of buf) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) {
        out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
    }
    return out;
}

export function base32Decode(input) {
    const s = String(input || "").trim().replace(/=+$/g, "").replace(/[\s-]/g, "").toUpperCase();
    if (!s) throw new Error("empty secret");
    if (!/^[A-Z2-7]+$/.test(s)) throw new Error("secret must be base32 (A-Z, 2-7)");
    let bits = 0;
    let value = 0;
    const bytes = [];
    for (const ch of s) {
        value = (value << 5) | BASE32_ALPHABET.indexOf(ch);
        bits += 5;
        if (bits >= 8) {
            bytes.push((value >>> (bits - 8)) & 0xff);
            bits -= 8;
        }
    }
    return Buffer.from(bytes);
}

export function normalizeOtpSecret(value) {
    return String(value ?? "").trim().replace(/[\s-]/g, "").replace(/=+$/g, "").toUpperCase();
}

export function normalizeOtpCode(value) {
    return String(value ?? "").trim().replace(/[\s-]/g, "");
}

// --- secret + otpauth URL ---------------------------------------------------

export function generateOtpSecret(numBytes = OTP_SECRET_BYTES) {
    return base32Encode(crypto.randomBytes(numBytes));
}

export function buildOtpAuthUrl(secret, { account = "llama-chat", issuer = "LlamaChat" } = {}) {
    const sec = normalizeOtpSecret(secret);
    const encIssuer = encodeURIComponent(issuer);
    const encAccount = encodeURIComponent(account);
    return `otpauth://totp/${encIssuer}:${encAccount}?secret=${sec}&issuer=${encIssuer}&algorithm=SHA1&digits=6&period=30`;
}

// --- TOTP core (RFC 6238, SHA-1) --------------------------------------------

function hotp(secretBytes, counter, digits = OTP_DIGITS) {
    const msg = Buffer.alloc(8);
    // 64-bit big-endian counter (counter fits in 53 bits for our lifetimes)
    const hi = Math.floor(counter / 0x100000000);
    const lo = counter >>> 0;
    msg.writeUInt32BE(hi, 0);
    msg.writeUInt32BE(lo, 4);
    const hmac = crypto.createHmac("sha1", secretBytes).update(msg).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const code =
        ((hmac[offset] & 0x7f) << 24) |
        ((hmac[offset + 1] & 0xff) << 16) |
        ((hmac[offset + 2] & 0xff) << 8) |
        (hmac[offset + 3] & 0xff);
    return String(code % 10 ** digits).padStart(digits, "0");
}

export function totpAt(secret, counter, digits = OTP_DIGITS) {
    const bytes = base32Decode(normalizeOtpSecret(secret));
    return hotp(bytes, counter, digits);
}

export function totpNow(secret, { nowMs = Date.now(), period = OTP_PERIOD_SECONDS, digits = OTP_DIGITS } = {}) {
    const counter = Math.floor(Math.floor(nowMs / 1000) / period);
    return hotp(base32Decode(normalizeOtpSecret(secret)), counter, digits);
}

export function verifyOtpCode(secret, code, { nowMs = Date.now(), window = OTP_WINDOW, period = OTP_PERIOD_SECONDS, digits = OTP_DIGITS } = {}) {
    try {
        const normalized = normalizeOtpCode(code);
        if (!new RegExp(`^\\d{${digits}}$`).test(normalized)) return false;
        const bytes = base32Decode(normalizeOtpSecret(secret));
        const counter = Math.floor(Math.floor(nowMs / 1000) / period);
        for (let d = -window; d <= window; d++) {
            const c = counter + d;
            if (c < 0) continue;
            const expected = Buffer.from(hotp(bytes, c, digits), "utf8");
            const actual = Buffer.from(normalized, "utf8");
            if (expected.length === actual.length && crypto.timingSafeEqual(expected, actual)) return true;
        }
        return false;
    } catch {
        return false;
    }
}

// --- settings helpers ---------------------------------------------------------

export function isOtpSet(settings) {
    const s = settings || {};
    return Boolean(s.otp_secret && String(s.otp_secret).trim().length >= 16);
}

export function setOtpSecret(settings, secret, { account = "llama-chat", issuer = "LlamaChat" } = {}) {
    const sec = normalizeOtpSecret(secret);
    try {
        const bytes = base32Decode(sec);
        if (bytes.length < 10) return { ok: false, message: "⚠️ That secret is too short — use the one printed by @otp-set (32 characters)." };
    } catch {
        return { ok: false, message: "⚠️ That secret is not valid base32 (A-Z, 2-7). Use the one printed by @otp-set." };
    }
    settings.otp_secret = sec;
    settings.otp_set_at = Date.now();
    if (account) settings.otp_account = String(account);
    if (issuer) settings.otp_issuer = String(issuer);
    return { ok: true, secret: sec };
}

export function clearOtpSecret(settings) {
    if (settings) {
        settings.otp_secret = "";
        settings.otp_set_at = 0;
    }
}
