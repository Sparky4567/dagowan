// YubiKey unit tests (sync path only; cloud verification requires network + creds)

import { describe, it, expect, beforeEach } from "bun:test";
import {
    YUBI_OTP_LENGTH,
    YUBI_PUBLIC_ID_LENGTH,
    YUBI_MODHEX,
    normalizeYubiOtp,
    normalizeYubiId,
    isValidYubiOtpFormat,
    extractYubiKeyId,
    isYubiSet,
    generateYubiOtp,
    setYubiKey,
    clearYubiKey,
    verifyYubiOtp,
} from "./yubikey.js";

describe("YubiKey — normalization & format", () => {
    it("normalizes OTP (trims, lowers, removes spaces)", () => {
        expect(normalizeYubiOtp("  CCCIVRKRNLDJV  ")).toBe("cccivrkrnldjv");
        expect(normalizeYubiOtp("CCCIVRKRNLDJV")).toBe("cccivrkrnldjv");
    });

    it("normalizes public id", () => {
        expect(normalizeYubiId("  CCCIVRKRNLD  ")).toBe("cccivrkrnld");
    });

    it("validates 44-char modhex OTP format", () => {
        expect(isValidYubiOtpFormat("cccivrkrnldjuetbgecvtdhvdebnilenjtcbuiluirkv")).toBe(true);
        expect(isValidYubiOtpFormat("cccivrkrnldj")).toBe(false); // too short
        expect(isValidYubiOtpFormat("zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz")).toBe(false); // invalid chars
        expect(isValidYubiOtpFormat("")).toBe(false);
    });

    it("extracts 12-char public id from OTP", () => {
        const otp = "cccivrkrnldjuetbgecvtdhvdebnilenjtcbuiluirkv";
        expect(extractYubiKeyId(otp)).toBe("cccivrkrnldj");
        expect(extractYubiKeyId("short")).toBe("");
    });
});

describe("YubiKey — enrollment & storage", () => {
    let settings;

    beforeEach(() => {
        settings = {};
    });

    it("enrolls with a full 44-char OTP", () => {
        const otp = "cccivrkrnldjuetbgecvtdhvdebnilenjtcbuiluirkv";
        const res = setYubiKey(settings, otp, { label: "test key" });
        expect(res.ok).toBe(true);
        expect(res.id).toBe("cccivrkrnldj");
        expect(settings.yubikey_id).toBe("cccivrkrnldj");
        expect(settings.yubikey_label).toBe("test key");
        expect(settings.yubikey_last_otp).toBe("");
    });

    it("enrolls with only the 12-char public id", () => {
        const res = setYubiKey(settings, "cccivrkrnldj", { label: "id only" });
        expect(res.ok).toBe(true);
        expect(res.id).toBe("cccivrkrnldj");
        expect(settings.yubikey_id).toBe("cccivrkrnldj");
    });

    it("auto-generates a code when no value provided (demo mode)", () => {
        const res = setYubiKey(settings, "");
        expect(res.ok).toBe(true);
        expect(res.id.length).toBe(12);
        expect(res.code).toBeDefined();
        expect(res.code.length).toBe(44);
        expect(settings.yubikey_id).toBe(res.id);
    });

    it("rejects invalid input", () => {
        const res = setYubiKey(settings, "not-a-valid-otp");
        expect(res.ok).toBe(false);
        expect(res.message).toContain("Provide a 44-character YubiKey OTP");
    });

    it("clears all YubiKey settings", () => {
        setYubiKey(settings, "cccivrkrnldjuetbgecvtdhvdebnilenjtcbuiluirkv", { label: "test" });
        clearYubiKey(settings);
        expect(settings.yubikey_id).toBe("");
        expect(settings.yubikey_set_at).toBe(0);
        expect(settings.yubikey_label).toBe("");
        expect(settings.yubikey_last_otp).toBe("");
        expect(settings.yubikey_pending_id).toBe("");
        expect(settings.yubikey_pending_label).toBe("");
        expect(settings.yubikey_pending_at).toBe(0);
        expect(settings.yubikey_pin_hash).toBe("");
        expect(settings.yubikey_pin_salt).toBe("");
        expect(settings.yubikey_pin_set_at).toBe(0);
        expect(settings.yubikey_pending_pin_hash).toBe("");
        expect(settings.yubikey_pending_pin_salt).toBe("");
        expect(settings.yubikey_automode).toBe(false);
    });
});

describe("YubiKey — verification (sync, offline)", () => {
    let settings;

    beforeEach(() => {
        settings = {};
        setYubiKey(settings, "cccivrkrnldjuetbgecvtdhvdebnilenjtcbuiluirkv");
    });

    it("accepts a valid, non-replayed OTP for the enrolled key", () => {
        const fresh = generateYubiOtp("cccivrkrnldj");
        expect(verifyYubiOtp(settings, fresh)).toBe(true);
        // last_otp updated
        expect(settings.yubikey_last_otp).toBe(fresh.toLowerCase());
    });

    it("rejects OTP from a different public id", () => {
        const other = generateYubiOtp("vvvvvvvvvvvv");
        expect(verifyYubiOtp(settings, other)).toBe(false);
    });

    it("rejects replayed OTP", () => {
        const fresh = generateYubiOtp("cccivrkrnldj");
        expect(verifyYubiOtp(settings, fresh)).toBe(true);
        expect(verifyYubiOtp(settings, fresh)).toBe(false); // replay
    });

    it("rejects malformed OTP", () => {
        expect(verifyYubiOtp(settings, "notvalid")).toBe(false);
        expect(verifyYubiOtp(settings, "")).toBe(false);
    });

    it("rejects when no key is enrolled", () => {
        const empty = {};
        expect(verifyYubiOtp(empty, generateYubiOtp("cccivrkrnldj"))).toBe(false);
    });
});

describe("YubiKey — generateYubiOtp", () => {
    it("generates a valid 44-char modhex code", () => {
        const code = generateYubiOtp();
        expect(code.length).toBe(YUBI_OTP_LENGTH);
        expect(isValidYubiOtpFormat(code)).toBe(true);
    });

    it("uses supplied public id as prefix", () => {
        const code = generateYubiOtp("cccivrkrnldj");
        expect(code.length).toBe(YUBI_OTP_LENGTH);
        expect(code.startsWith("cccivrkrnldj")).toBe(true);
        expect(isValidYubiOtpFormat(code)).toBe(true);
    });

    it("generates different payloads each call", () => {
        const a = generateYubiOtp("cccivrkrnldj");
        const b = generateYubiOtp("cccivrkrnldj");
        expect(a).not.toBe(b);
        expect(a.slice(0, 12)).toBe(b.slice(0, 12));
    });
});

describe("YubiKey — isYubiSet", () => {
    it("returns false when no key enrolled", () => {
        expect(isYubiSet({})).toBe(false);
        expect(isYubiSet({ yubikey_id: "" })).toBe(false);
    });

    it("returns true when 12-char id present", () => {
        expect(isYubiSet({ yubikey_id: "cccivrkrnldj" })).toBe(true);
    });
});