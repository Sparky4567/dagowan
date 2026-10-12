import { test, expect } from "bun:test";
import {
    base32Decode,
    base32Encode,
    buildOtpAuthUrl,
    generateOtpSecret,
    totpAt,
    totpNow,
    verifyOtpCode,
    isOtpSet,
} from "./otp.js";
import {
    CLI_SCOPE,
    isOtpAuthenticated,
    isSurfaceLocked,
    lockAllScopes,
    lockedMessage,
    otpLoginScope,
    otpLockScope,
    runOtpCommand,
    runSecurityCommand,
} from "./security.js";

test("base32 roundtrip", () => {
    const secret = generateOtpSecret();
    expect(secret.length).toBe(32);
    expect(/^[A-Z2-7]{32}$/.test(secret)).toBe(true);
    const bytes = base32Decode(secret);
    expect(bytes.length).toBe(20);
    expect(base32Encode(bytes)).toBe(secret);
});

test("HOTP test vectors (RFC 4226, secret = '12345678901234567890')", () => {
    // base32 of ASCII "12345678901234567890"
    const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    expect(totpAt(secret, 0)).toBe("755224");
    expect(totpAt(secret, 1)).toBe("287082");
    expect(totpAt(secret, 2)).toBe("359152");
});

test("verify accepts current step and ±1 window, rejects garbage", () => {
    const secret = generateOtpSecret();
    const nowMs = 1_700_000_000_000;
    const code = totpNow(secret, { nowMs });
    expect(verifyOtpCode(secret, code, { nowMs })).toBe(true);
    expect(verifyOtpCode(secret, "000000", { nowMs })).toBe(false);
    expect(verifyOtpCode(secret, "abcdef", { nowMs })).toBe(false);
    expect(verifyOtpCode(secret, "", { nowMs })).toBe(false);
    // neighboring step within window
    const prev = totpNow(secret, { nowMs: nowMs - 30_000 });
    expect(verifyOtpCode(secret, prev, { nowMs })).toBe(true);
    // far step outside window
    const far = totpNow(secret, { nowMs: nowMs - 300_000 });
    expect(verifyOtpCode(secret, far, { nowMs, window: 1 })).toBe(false);
});

test("otpauth URL format works with authenticator apps", () => {
    const url = buildOtpAuthUrl("JBSWY3DPEHPK3PXP", { account: "bob", issuer: "TestApp" });
    expect(url.startsWith("otpauth://totp/TestApp:bob?")).toBe(true);
    expect(url).toContain("secret=JBSWY3DPEHPK3PXP");
    expect(url).toContain("issuer=TestApp");
});

test("otp-set enrolls, otp-login gates control commands", () => {
    lockAllScopes();
    const s = {};
    const scope = "test:otp-basic";
    expect(isOtpSet(s)).toBe(false);
    expect(isSurfaceLocked(s, scope)).toBe(false);

    const setRes = runOtpCommand("@otp-set", s, scope);
    expect(setRes.handled).toBe(true);
    expect(setRes.settingsChanged).toBe(true);
    expect(isOtpSet(s)).toBe(true);
    expect(setRes.reply).toContain("otpauth://totp/");
    expect(isOtpAuthenticated(scope)).toBe(true);
    expect(isSurfaceLocked(s, scope)).toBe(false);

    otpLockScope(scope);
    expect(isSurfaceLocked(s, scope)).toBe(true);
    expect(lockedMessage(s, scope)).toContain("@otp-login");

    const bad = runOtpCommand("@otp-login 000000", s, scope);
    expect(bad.settingsChanged).toBe(false);
    expect(isSurfaceLocked(s, scope)).toBe(true);

    const good = totpNow(s.otp_secret);
    const ok = runOtpCommand(`@otp-login ${good}`, s, scope);
    expect(isSurfaceLocked(s, scope)).toBe(false);
    expect(ok.reply).toContain("OTP accepted");
});

test("OTP layer sits before @unlock", () => {
    lockAllScopes();
    const s = {};
    const scope = "test:otp-before-pin";
    runSecurityCommand("@set-security-pin 482916", s, scope);
    runOtpCommand("@otp-set", s, scope);
    // drop both layers
    runSecurityCommand("@lock", s, scope);
    otpLockScope(scope);
    expect(isSurfaceLocked(s, scope)).toBe(true);

    // @unlock with the right PIN is refused until OTP passes
    const refused = runSecurityCommand("@unlock 482916", s, scope);
    expect(refused.reply).toContain("@otp-login");

    // OTP first, then PIN
    runOtpCommand(`@otp-login ${totpNow(s.otp_secret)}`, s, scope);
    expect(isSurfaceLocked(s, scope)).toBe(true); // PIN still locked
    const un = runSecurityCommand("@unlock 482916", s, scope);
    expect(isSurfaceLocked(s, scope)).toBe(false);
    expect(un.reply).toContain("Unlocked");
});

test("@otp-set enroll needs PIN unlock when a PIN is set", () => {
    lockAllScopes();
    const s = {};
    const scope = "test:otp-enroll-gate";
    runSecurityCommand("@set-security-pin 482916", s, scope);
    runSecurityCommand("@lock", s, scope);
    const r = runOtpCommand("@otp-set", s, scope);
    expect(r.settingsChanged).toBe(false);
    expect(isOtpSet(s)).toBe(false);
    expect(r.reply).toContain("@unlock");
});

test("@otp-remove needs BOTH otp auth and PIN unlock", () => {
    lockAllScopes();
    const s = {};
    const scope = "test:otp-remove";
    runSecurityCommand("@set-security-pin 482916", s, scope);
    runOtpCommand("@otp-set", s, scope); // enrolled + authed + unlocked

    // lock PIN only, keep OTP auth -> remove refused (PIN layer)
    runSecurityCommand("@lock", s, scope);
    let r = runOtpCommand("@otp-remove", s, scope);
    expect(r.settingsChanged).toBe(false);
    expect(isOtpSet(s)).toBe(true);
    expect(r.reply).toContain("@unlock");

    // unlock PIN, drop OTP -> remove refused (OTP layer)
    runSecurityCommand("@unlock 482916", s, scope);
    otpLockScope(scope);
    r = runOtpCommand("@otp-remove", s, scope);
    expect(r.settingsChanged).toBe(false);
    expect(r.reply).toContain("@otp-login");

    // inline code + unlocked PIN -> removed
    const code = totpNow(s.otp_secret);
    r = runOtpCommand(`@otp-remove ${code}`, s, scope);
    expect(r.settingsChanged).toBe(true);
    expect(isOtpSet(s)).toBe(false);
    expect(isSurfaceLocked(s, scope)).toBe(false);
});

test("@otp-remove with no PIN set needs OTP auth only", () => {
    lockAllScopes();
    const s = {};
    const scope = "test:otp-remove-nopin";
    runOtpCommand("@otp-set", s, scope);
    otpLockScope(scope);
    let r = runOtpCommand("@otp-remove", s, scope);
    expect(r.settingsChanged).toBe(false);
    r = runOtpCommand(`@otp-remove ${totpNow(s.otp_secret)}`, s, scope);
    expect(r.settingsChanged).toBe(true);
    expect(isOtpSet(s)).toBe(false);
});

test("@otp-lock and @otp-status", () => {
    lockAllScopes();
    const s = {};
    const scope = "test:otp-status";
    let r = runOtpCommand("@otp-status", s, scope);
    expect(r.reply).toContain("not enrolled");
    runOtpCommand("@otp-set", s, scope);
    r = runOtpCommand("@otp-status", s, scope);
    expect(r.reply).toContain("authenticated");
    runOtpCommand("@otp-lock", s, scope);
    expect(isSurfaceLocked(s, scope)).toBe(true);
    r = runOtpCommand("@otp-status", s, scope);
    expect(r.reply).toContain("NOT authenticated");
});

test("scopes are independent for OTP too", () => {
    lockAllScopes();
    const s = {};
    runOtpCommand("@otp-set", s, CLI_SCOPE);
    otpLockScope(CLI_SCOPE);
    runOtpCommand(`@otp-login ${totpNow(s.otp_secret)}`, s, CLI_SCOPE);
    expect(isSurfaceLocked(s, CLI_SCOPE)).toBe(false);
    expect(isSurfaceLocked(s, "telegram:999")).toBe(true);
});
