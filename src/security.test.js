import { test, expect } from "bun:test";
import {
    CLI_SCOPE,
    clearSecurityPin,
    formatUnlockDuration,
    getUnlockTtlMinutes,
    isProbablyControlCommand,
    isSecurityPinSet,
    isScopeUnlocked,
    isSurfaceLocked,
    lockAllScopes,
    lockScope,
    lockedMessage,
    otpLoginHelpLine,
    runSecurityCommand,
    setSecurityPin,
    telegramScope,
    unlockDurationInfo,
    unlockHelpLine,
    validateSecurityPinFormat,
    verifySecurityPin,
    whatsappScope,
} from "./security.js";

test("validateSecurityPinFormat enforces 6+ digits", () => {
    expect(validateSecurityPinFormat("482916").ok).toBe(true);
    expect(validateSecurityPinFormat("12345678901234567890123456789012").ok).toBe(true); // 32
    expect(validateSecurityPinFormat("123456789012345678901234567890123").ok).toBe(false); // 33
    expect(validateSecurityPinFormat("12345").ok).toBe(false);
    expect(validateSecurityPinFormat("abcdef").ok).toBe(false);
    expect(validateSecurityPinFormat("123 456").ok).toBe(false);
    expect(validateSecurityPinFormat("").ok).toBe(false);
    expect(validateSecurityPinFormat("12ab56").ok).toBe(false);
});

test("set/verify/clear roundtrip, no plaintext stored", () => {
    lockAllScopes();
    const s = {};
    expect(isSecurityPinSet(s)).toBe(false);
    expect(verifySecurityPin(s, "482916")).toBe(false);
    const res = setSecurityPin(s, "482916");
    expect(res.ok).toBe(true);
    expect(isSecurityPinSet(s)).toBe(true);
    expect(s.security_pin_hash).not.toContain("482916");
    expect(String(s.security_pin_salt).length).toBeGreaterThan(0);
    expect(verifySecurityPin(s, "482916")).toBe(true);
    expect(verifySecurityPin(s, "482917")).toBe(false);
    expect(verifySecurityPin(s, "")).toBe(false);
    clearSecurityPin(s);
    expect(isSecurityPinSet(s)).toBe(false);
    expect(verifySecurityPin(s, "482916")).toBe(false);
});

test("runSecurityCommand: first set, lock, wrong/right unlock, status", () => {
    lockAllScopes();
    const s = {};
    const scope = "test:cli";

    let r = runSecurityCommand("@set-security-pin 12", s, scope);
    expect(r.handled).toBe(true);
    expect(isSecurityPinSet(s)).toBe(false); // too short -> rejected

    r = runSecurityCommand("@set-security-pin 482916", s, scope);
    expect(r.handled).toBe(true);
    expect(r.settingsChanged).toBe(true);
    expect(isSecurityPinSet(s)).toBe(true);
    expect(isScopeUnlocked(scope)).toBe(true); // setting the PIN unlocks this surface

    r = runSecurityCommand("@lock", s, scope);
    expect(r.handled).toBe(true);
    expect(isSurfaceLocked(s, scope)).toBe(true);

    r = runSecurityCommand("@unlock 000000", s, scope);
    expect(r.handled).toBe(true);
    expect(isSurfaceLocked(s, scope)).toBe(true); // wrong PIN stays locked

    r = runSecurityCommand("@unlock", s, scope);
    expect(r.handled).toBe(true);
    expect(isSurfaceLocked(s, scope)).toBe(true); // missing PIN stays locked

    r = runSecurityCommand("@unlock 482916", s, scope);
    expect(r.handled).toBe(true);
    expect(isSurfaceLocked(s, scope)).toBe(false);

    r = runSecurityCommand("@security-status", s, scope);
    expect(r.handled).toBe(true);
    expect(r.reply).toContain("unlocked");

    // "/" prefix works too
    r = runSecurityCommand("/lock", s, scope);
    expect(r.handled).toBe(true);
    expect(isSurfaceLocked(s, scope)).toBe(true);
    r = runSecurityCommand("/security-status", s, scope);
    expect(r.reply).toContain("locked");
});

test("runSecurityCommand: change PIN unlocked, or locked with current PIN", () => {
    lockAllScopes();
    const s = {};
    const scope = "test:change";
    runSecurityCommand("@set-security-pin 482916", s, scope);

    // change while unlocked (no current PIN needed)
    let r = runSecurityCommand("@set-security-pin 111222", s, scope);
    expect(r.settingsChanged).toBe(true);
    expect(verifySecurityPin(s, "111222")).toBe(true);
    expect(verifySecurityPin(s, "482916")).toBe(false);

    runSecurityCommand("@lock", s, scope);

    // change while locked without current PIN -> refused
    r = runSecurityCommand("@set-security-pin 333444", s, scope);
    expect(r.settingsChanged).toBe(false);
    expect(verifySecurityPin(s, "111222")).toBe(true);

    // change while locked with wrong current PIN -> refused
    r = runSecurityCommand("@set-security-pin 333444 000000", s, scope);
    expect(r.settingsChanged).toBe(false);

    // change while locked with correct current PIN -> allowed
    r = runSecurityCommand("@set-security-pin 333444 111222", s, scope);
    expect(r.settingsChanged).toBe(true);
    expect(verifySecurityPin(s, "333444")).toBe(true);
});

test("runSecurityCommand: remove PIN needs unlock or current PIN", () => {
    lockAllScopes();
    const s = {};
    const scope = "test:remove";
    runSecurityCommand("@set-security-pin 482916", s, scope);
    runSecurityCommand("@lock", s, scope);

    let r = runSecurityCommand("@remove-security-pin", s, scope);
    expect(r.settingsChanged).toBe(false);
    expect(isSecurityPinSet(s)).toBe(true);

    r = runSecurityCommand("@remove-security-pin 000000", s, scope);
    expect(r.settingsChanged).toBe(false);
    expect(isSecurityPinSet(s)).toBe(true);

    r = runSecurityCommand("@clear-security-pin 482916", s, scope);
    expect(r.settingsChanged).toBe(true);
    expect(isSecurityPinSet(s)).toBe(false);
});

test("runSecurityCommand: unlock/lock with no PIN set", () => {
    lockAllScopes();
    const s = {};
    const r = runSecurityCommand("@unlock 123456", s, "test:none");
    expect(r.handled).toBe(true);
    expect(r.reply).toContain("No security PIN");
    const r2 = runSecurityCommand("@lock", s, "test:none");
    expect(r2.reply).toContain("No security PIN");
});

test("unlock scopes are independent per surface", () => {
    lockAllScopes();
    const s = {};
    runSecurityCommand("@set-security-pin 482916", s, CLI_SCOPE);
    lockScope(CLI_SCOPE);
    runSecurityCommand("@unlock 482916", s, CLI_SCOPE);
    expect(isSurfaceLocked(s, CLI_SCOPE)).toBe(false);
    expect(isSurfaceLocked(s, telegramScope(1))).toBe(true);
    expect(isSurfaceLocked(s, whatsappScope("1@g.us"))).toBe(true);
    expect(isSurfaceLocked({}, CLI_SCOPE)).toBe(false); // no PIN -> never locked
});

test("getUnlockTtlMinutes clamps to 1..1440, default 10", () => {
    expect(getUnlockTtlMinutes({})).toBe(10);
    expect(getUnlockTtlMinutes({ security_unlock_minutes: 5 })).toBe(5);
    expect(getUnlockTtlMinutes({ security_unlock_minutes: 0 })).toBe(1);
    expect(getUnlockTtlMinutes({ security_unlock_minutes: -3 })).toBe(1);
    expect(getUnlockTtlMinutes({ security_unlock_minutes: 9999 })).toBe(1440);
    expect(getUnlockTtlMinutes({ security_unlock_minutes: "abc" })).toBe(10);
});

test("isProbablyControlCommand tells commands apart from mention chat", () => {
    const chars = [{ name: "Parsly", id: "parsly-1" }];
    expect(isProbablyControlCommand("@set-setting a b", chars)).toBe(true);
    expect(isProbablyControlCommand("/help", chars)).toBe(true);
    expect(isProbablyControlCommand("@remember x", chars)).toBe(true);
    expect(isProbablyControlCommand("@play some song", chars)).toBe(true);
    expect(isProbablyControlCommand("@simulation foo", chars)).toBe(true);
    expect(isProbablyControlCommand("@unlock 123456", chars)).toBe(true);
    expect(isProbablyControlCommand("@unknowncmd foo", chars)).toBe(true);
    expect(isProbablyControlCommand("hello there", chars)).toBe(false);
    expect(isProbablyControlCommand("@Parsly hello, what do you think?", chars)).toBe(false);
    expect(isProbablyControlCommand("@Parsly @set-setting a b", chars)).toBe(true);
    expect(isProbablyControlCommand("", chars)).toBe(false);
});

test("lockedMessage points at @unlock", () => {
    expect(lockedMessage({})).toContain("@unlock");
});

test("info messages render live security_unlock_minutes (no hard-coded durations)", () => {
    lockAllScopes();
    // formatter: singular vs plural, clamping via settings
    expect(formatUnlockDuration(1)).toBe("1 minute");
    expect(formatUnlockDuration(60)).toBe("60 minutes");
    expect(formatUnlockDuration({ security_unlock_minutes: 45 })).toBe("45 minutes");
    expect(unlockDurationInfo({ security_unlock_minutes: 45 })).toBe("45 minutes (security_unlock_minutes=45)");
    expect(unlockDurationInfo({})).toBe("10 minutes (security_unlock_minutes=10)");

    // lockedMessage reflects the setting
    const locked60 = lockedMessage(
        { security_unlock_minutes: 60, security_pin_hash: "h", security_pin_salt: "s" },
        "test:dyn"
    );
    expect(locked60).toContain("60 minutes");
    expect(locked60).not.toContain("10 minutes");
    const locked1 = lockedMessage(
        { security_unlock_minutes: 1, security_pin_hash: "h", security_pin_salt: "s" },
        "test:dyn"
    );
    expect(locked1).toContain("1 minute");
    expect(locked1).not.toContain("1 minutes");

    // @unlock reply reflects the setting
    lockAllScopes();
    const s = { security_unlock_minutes: 30 };
    runSecurityCommand("@set-security-pin 482916", s, "test:dyn-unlock");
    runSecurityCommand("@lock", s, "test:dyn-unlock");
    const un = runSecurityCommand("@unlock 482916", s, "test:dyn-unlock");
    expect(un.reply).toContain("30 minutes");
    expect(un.reply).not.toContain("10 minutes");

    // @security-status reflects the setting
    const st = runSecurityCommand("@security-status", s, "test:dyn-unlock");
    expect(st.reply).toContain("security_unlock_minutes=30");

    // @help manual lines (single source of truth used by buildCommandsHelp
    // on every surface) reflect the setting, with no hard-coded durations
    const line60 = unlockHelpLine({ security_unlock_minutes: 60 });
    expect(line60).toContain("60 minutes (security_unlock_minutes=60)");
    expect(line60).not.toContain("for N minutes");
    expect(line60).not.toContain("(default 10)");
    const line7 = unlockHelpLine({ security_unlock_minutes: 7 });
    expect(line7).toContain("7 minutes (security_unlock_minutes=7)");
    const otpLine45 = otpLoginHelpLine({ security_unlock_minutes: 45 });
    expect(otpLine45).toContain("45 minutes (security_unlock_minutes=45)");
});
