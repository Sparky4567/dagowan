// ---------------------------------------------------------------------------
// Security PIN — protects control commands from unwanted settings changes.
//
// When a PIN is set (via @set-security-pin), every control command (any
// "@..." / "/..." command plus natural blog side-effect intents)
// requires an unlock first (@unlock <pin>). Regular chatting — including
// "@Name" persona mentions — always works without the PIN.
//
// The PIN itself is never stored in plain text: only a SHA-256(salt:pin)
// hash plus a random salt live in app_settings.json. Unlock state is
// in-memory only (per surface scope) and expires after
// `security_unlock_minutes` (default 10), so a restart always re-locks.
//
// Surfaces and their unlock scopes:
//   CLI                -> "cli"
//   Telegram per chat  -> "telegram:<chatId>"
//   WhatsApp per chat  -> "whatsapp:<chatId>"
//   Web UI (single)    -> "web"
//
// Recovery: if the PIN is lost or hijacked, stop the bot and delete
// `security_pin_hash` / `security_pin_salt` from app_settings.json locally.
// ---------------------------------------------------------------------------

import crypto from "node:crypto";
import { findMentionedCharacters, stripCharacterMentions } from "./whatsapp_mentions.js";
import {
    OTP_KEYS as OTP_SETTING_KEYS,
    buildOtpAuthUrl,
    clearOtpSecret,
    generateOtpSecret,
    isOtpSet,
    normalizeOtpCode,
    setOtpSecret,
    verifyOtpCode,
} from "./otp.js";

export { isOtpSet };
export const OTP_KEYS = OTP_SETTING_KEYS;

export const SECURITY_PIN_MIN_LENGTH = 6;
export const SECURITY_PIN_MAX_LENGTH = 32;
export const SECURITY_PIN_PATTERN = /^\d{6,32}$/;
export const DEFAULT_UNLOCK_MINUTES = 10;
export const MAX_UNLOCK_MINUTES = 1440;
export const MIN_UNLOCK_MINUTES = 1;

// --- dynamic duration helpers ------------------------------------------------
// Single source of truth for user-facing unlock-duration text. All lock /
// unlock / OTP info messages must go through these so the wording always
// reflects the live `security_unlock_minutes` value from app_settings.json
// instead of a hard-coded string like "default 10" / "N minutes".

export function formatUnlockDuration(settingsOrMinutes) {
    const mins = typeof settingsOrMinutes === "number" && Number.isFinite(settingsOrMinutes)
        ? Math.min(Math.max(Math.floor(settingsOrMinutes), MIN_UNLOCK_MINUTES), MAX_UNLOCK_MINUTES)
        : getUnlockTtlMinutes(settingsOrMinutes);
    return `${mins} minute${mins === 1 ? "" : "s"}`;
}

// e.g. "60 minutes (security_unlock_minutes=60)". Used by @help / info lines.
export function unlockDurationInfo(settings) {
    const mins = getUnlockTtlMinutes(settings);
    return `${formatUnlockDuration(mins)} (security_unlock_minutes=${mins})`;
}

// Full @help manual lines for the lock duration, generated from live settings
// so commands.js (and every surface using it) never hard-codes "N minutes"
// or "(default 10)". Tested in security.test.js without pulling in the
// heavy commands.js dependency graph.
export function unlockHelpLine(settings) {
    return `• @unlock <pin> — Unlock control commands on this surface for ${unlockDurationInfo(settings)} (change via @set-setting security_unlock_minutes <1-1440> while unlocked). When OTP is enrolled, @otp-login is required BEFORE @unlock`;
}

export function otpLoginHelpLine(settings) {
    return `• @otp-login <6-digit code> — Authenticate this surface with the current authenticator code (each of CLI / Telegram / WhatsApp / Web logs in separately; lasts ${unlockDurationInfo(settings)} per login)`;
}

export const CLI_SCOPE = "cli";
export const WEB_SCOPE = "web";
export const telegramScope = (chatId) => `telegram:${String(chatId ?? "")}`;
export const whatsappScope = (chatId) => `whatsapp:${String(chatId ?? "")}`;

// Keys that must only change via @set-security-pin / @remove-security-pin.
// @set-setting and the web update_settings event must refuse these.
export const SECURITY_PIN_KEYS = ["security_pin_hash", "security_pin_salt", "security_pin_set_at"];

// --- PIN handling -----------------------------------------------------------

export function normalizePin(value) {
    return String(value ?? "").trim();
}

export function validateSecurityPinFormat(pin) {
    const p = normalizePin(pin);
    if (!p) {
        return { ok: false, message: `⚠️ Usage: @set-security-pin <${SECURITY_PIN_MIN_LENGTH}+ digits> (digits only, e.g. @set-security-pin 482916)` };
    }
    if (!SECURITY_PIN_PATTERN.test(p)) {
        return {
            ok: false,
            message: `⚠️ The security PIN must be digits only, at least ${SECURITY_PIN_MIN_LENGTH} digits (up to ${SECURITY_PIN_MAX_LENGTH}). Example: @set-security-pin 482916`,
        };
    }
    return { ok: true, pin: p };
}

export function isSecurityPinSet(settings) {
    const s = settings || {};
    return Boolean(s.security_pin_hash && s.security_pin_salt);
}

function hashPin(pin, salt) {
    return crypto.createHash("sha256").update(`${salt}:${pin}`, "utf8").digest("hex");
}

export function setSecurityPin(settings, pin) {
    const checked = validateSecurityPinFormat(pin);
    if (!checked.ok) return checked;
    const salt = crypto.randomBytes(16).toString("hex");
    settings.security_pin_hash = hashPin(checked.pin, salt);
    settings.security_pin_salt = salt;
    settings.security_pin_set_at = Date.now();
    return { ok: true, pin: checked.pin };
}

export function clearSecurityPin(settings) {
    if (settings) {
        settings.security_pin_hash = "";
        settings.security_pin_salt = "";
        settings.security_pin_set_at = 0;
    }
}

export function verifySecurityPin(settings, pin) {
    try {
        if (!isSecurityPinSet(settings)) return false;
        const p = normalizePin(pin);
        if (!p) return false;
        const expected = Buffer.from(String(settings.security_pin_hash), "utf8");
        const actual = Buffer.from(hashPin(p, String(settings.security_pin_salt)), "utf8");
        if (expected.length !== actual.length) return false;
        return crypto.timingSafeEqual(expected, actual);
    } catch {
        return false;
    }
}

// --- unlock state (in-memory, per scope) ------------------------------------

const unlocks = new Map(); // scope -> expiry epoch ms

export function getUnlockTtlMinutes(settings) {
    const raw = Number(settings?.security_unlock_minutes ?? DEFAULT_UNLOCK_MINUTES);
    if (!Number.isFinite(raw)) return DEFAULT_UNLOCK_MINUTES;
    return Math.min(Math.max(Math.floor(raw), 1), MAX_UNLOCK_MINUTES);
}

export function unlockScope(scope, settings) {
    const ttlMs = getUnlockTtlMinutes(settings) * 60 * 1000;
    unlocks.set(String(scope), Date.now() + ttlMs);
}

export function lockScope(scope) {
    unlocks.delete(String(scope));
}

export function lockAllScopes() {
    unlocks.clear();
    otpAuths.clear();
}

export function isScopeUnlocked(scope) {
    const key = String(scope);
    const until = unlocks.get(key);
    if (!until) return false;
    if (Date.now() >= until) {
        unlocks.delete(key);
        return false;
    }
    return true;
}

export function unlockRemainingMinutes(scope) {
    const until = unlocks.get(String(scope));
    if (!until) return 0;
    return Math.max(0, (until - Date.now()) / 60000);
}

// --- OTP auth state (in-memory, per scope) -----------------------------------
// The OTP layer sits BEFORE @unlock: when an OTP secret is enrolled, a
// surface must pass @otp-login before @unlock (or any control command) is
// accepted. TTL reuses security_unlock_minutes so both layers expire together.

const otpAuths = new Map(); // scope -> expiry epoch ms

export function otpLoginScope(scope, settings) {
    const ttlMs = getUnlockTtlMinutes(settings) * 60 * 1000;
    otpAuths.set(String(scope), Date.now() + ttlMs);
}

export function otpLockScope(scope) {
    otpAuths.delete(String(scope));
}

export function otpLockAllScopes() {
    otpAuths.clear();
}

export function isOtpAuthenticated(scope) {
    const key = String(scope);
    const until = otpAuths.get(key);
    if (!until) return false;
    if (Date.now() >= until) {
        otpAuths.delete(key);
        return false;
    }
    return true;
}

export function otpRemainingMinutes(scope) {
    const until = otpAuths.get(String(scope));
    if (!until) return 0;
    return Math.max(0, (until - Date.now()) / 60000);
}

export function isSurfaceLocked(settings, scope) {
    const pinLocked = isSecurityPinSet(settings) && !isScopeUnlocked(scope);
    const otpLocked = isOtpSet(settings) && !isOtpAuthenticated(scope);
    return pinLocked || otpLocked;
}

// --- messages ---------------------------------------------------------------

export function lockedMessage(settings, scope = null) {
    const duration = formatUnlockDuration(settings);
    const parts = [];
    if (isOtpSet(settings) && scope !== null && !isOtpAuthenticated(scope)) {
        parts.push(`🔐 OTP required — authenticate with @otp-login <6-digit code from your authenticator app> (enroll with @otp-set).`);
    }
    if (isSecurityPinSet(settings) && scope !== null && !isScopeUnlocked(scope)) {
        parts.push(`🔒 Locked — control commands are protected by the security PIN. Unlock with @unlock <pin> (stays unlocked for ${duration}; re-lock anytime with @lock). Regular chatting still works without the PIN.`);
    } else if (parts.length === 0) {
        parts.push(`🔒 Locked — control commands are protected. Unlock with @unlock <pin> (stays unlocked for ${duration}; re-lock anytime with @lock). Regular chatting still works without the PIN.`);
    }
    return parts.join("\n");
}

// --- command classification -------------------------------------------------
// Used to tell "@set-setting ..." (control → blocked while locked) apart
// from "@Parsly hello" (persona mention chat → always allowed) and from
// unknown "@foo" text (treated as control-shaped → blocked while locked).

const CONTROL_WORDS = new Set([
    // help / security (handled before the gate, listed here for completeness)
    "help", "commands", "get-commands",
    "set-security-pin", "set-pin", "security-pin",
    "remove-security-pin", "clear-security-pin", "disable-security-pin",
    "unset-security-pin", "remove-pin", "unlock", "unlock-pin", "lock",
    "security-status", "security", "pin-status",
    // OTP second factor (handled while locked, like the PIN family)
    "otp-set", "otp-login", "otp-lock", "otp-remove", "otp-status", "otp",
    // coding agents
    "babyagi", "babyagi-status", "make", "create-file",
    "opencli", "opencode", "opencode-model", "opencode-setup",
    "opencode-setup-auto-allow", "change-project-path", "set-project-path",
    "project-path", "projects-path", "set-projects-path",
    // proactive / timers
    "proactive", "proactive-chat", "proactive-status", "proactive-timer",
    "proactive-timer-status", "proactive-check", "set-proactive-timer",
    "set-proactive-check", "stop-proactive", "stop-proactive-timer",
    // memory / knowledge / learning
    "remember", "memories", "memory", "memories-all", "memory-all",
    "list-memories", "list-memories-all", "memory-langs", "memory-lang",
    "memories-lang", "forget", "delete-memory", "update-memory", "correct",
    "knowledge", "list-knowledge", "teach", "knowledge-history",
    "delete-knowledge", "stats", "learning-stats", "get-stats",
    "learning-logs", "set-learning", "auto-learning", "rules",
    "candidate-rules", "approve-rule",
    // tasks
    "register-task", "task", "get-tasks", "tasks", "all-tasks",
    "move-task", "delete-task", "set-task-reminder", "stop-task-reminder",
    "task-reminder-status",
    // settings / backups / keys
    "settings", "get-settings", "list-settings", "set-setting",
    "set-server-url", "server-url", "set-mem-limit", "mem-limit",
    "set-workspace", "workspace", "export-settings", "backup",
    "import-settings", "restore", "list-backups", "set-api-key", "set-key",
    "api-keys", "keys",
    // models / characters / polling
    "models", "model", "characters", "character", "polling-status",
    "polling", "pollers", "wake", "sleep", "set-polling-idle",
    "polling-idle", "create-character", "set-telegram-token",
    "set-persona-prompt", "whatsapp-pair", "set-whatsapp-phone",
    "whatsapp-number", "whatsapp-enabled", "set-whatsapp", "whatsapp",
    "reset-whatsapp-auth",
    // sessions / notes / voice
    "sessions", "session", "new-session", "delete-session",
    "rename-session", "fetch-note-about", "write-about", "convert-pdf",
    "pdf", "pdf-to-md", "convert-md", "voice", "tts", "voice-reply",
    "voicereply", "voice-mode", "voicemode", "web", "voice-socket",
    "voice-server", "dagowan", "live-web", "web-search", "websearch", "search-web",
    "web-fetch", "webfetch", "web-open", "web-status", "websearch-status",
    "search-status", "clear",
    // playback / blog / fact-check
    "youtube-play", "play", "spotify-play", "spotify", "blogger-auth",
    "blog",
    "blogpost", "post", "wordpress", "wp", "blogger", "blogspot",
    "fact-check", "factcheck", "fact_check", "check-fact", "verify",
    // needle / browser / cast / mcp / simulation / agentic
    "needle", "needle-extract", "needle-embed", "needle-tools",
    "needle-status", "browser-search", "browser-search-spotify",
    "browser-open", "browser-read", "browser-shot", "browser-status",
    "browser-close", "search-youtube-for", "search-google-for",
    "search-giphy-for", "search-spotify-for", "open-browser",
    "cast-scan", "scan-tv", "cast", "cast-url", "cast-player",
    "cast-pause", "cast-play", "cast-status", "cast-stop", "stop-cast",
    "cast-device", "cast-devices", "set-cast-device", "mcp-status",
    "mcp-list", "mcp-tools", "mcp-call", "mcp-reconnect", "mcp-enable",
    "mcp-disable", "simulation", "simulations", "simulation-search",
    "simulation-show", "simulation-review", "insight", "insights",
    "insight-search", "insight-show", "insight-list", "insight-delete",
    "insight-status", "insight-auto",
]);

const CONTROL_PREFIXES = [
    "move-task-", "delete-task-", "simulation-", "blog-",
    "cast-", "mcp-", "needle-", "opencode-", "proactive-",
    "insight-",
];

export function isControlWord(text) {
    const trimmed = String(text || "").trim();
    if (!/^[@/]/.test(trimmed)) return false;
    const match = trimmed.match(/^[@/]([A-Za-z][A-Za-z0-9\-_]*)/);
    if (!match) return false;
    const word = match[1].toLowerCase();
    if (CONTROL_WORDS.has(word)) return true;
    return CONTROL_PREFIXES.some((p) => word.startsWith(p));
}

export function isSecurityCommand(lower) {
    const l = String(lower || "");
    return l === "/set-security-pin" || l.startsWith("/set-security-pin ") ||
        l === "/set-pin" || l.startsWith("/set-pin ") ||
        l === "/remove-security-pin" || l.startsWith("/remove-security-pin ") ||
        l === "/clear-security-pin" || l.startsWith("/clear-security-pin ") ||
        l === "/disable-security-pin" || l.startsWith("/disable-security-pin ") ||
        l === "/unset-security-pin" || l.startsWith("/unset-security-pin ") ||
        l === "/remove-pin" || l.startsWith("/remove-pin ") ||
        l === "/unlock" || l.startsWith("/unlock ") ||
        l === "/unlock-pin" || l.startsWith("/unlock-pin ") ||
        l === "/lock" || l.startsWith("/lock ") ||
        l === "/security-status" || l === "/security" || l === "/pin-status";
}

export function isHelpCommand(lower) {
    const l = String(lower || "");
    return l === "/help" || l === "/commands" || l === "/get-commands";
}

export function isOtpCommand(lower) {
    const l = String(lower || "");
    return l === "/otp-set" || l.startsWith("/otp-set ") ||
        l === "/otp-login" || l.startsWith("/otp-login ") ||
        l === "/otp-lock" || l.startsWith("/otp-lock ") ||
        l === "/otp-remove" || l.startsWith("/otp-remove ") ||
        l === "/otp-status" || l === "/otp" || l.startsWith("/otp ");
}

export function isProbablyControlCommand(text, characters = []) {
    const t = String(text || "").trim();
    if (!t) return false;
    // A known "@command" word always wins over a persona alias
    // (e.g. "@play ..." is the YouTube command even if a persona is
    // somehow named "Play").
    if (isControlWord(t)) return true;
    if (/^[@/]/.test(t)) {
        // "@Name ..." persona mention chat stays allowed while locked;
        // anything still starting with @ or / after stripping mentions
        // (unknown "@foo", "@Name @set-setting ...") is control-shaped.
        try {
            const mentioned = findMentionedCharacters(t, characters || []);
            const stripped = (mentioned.length > 0
                ? stripCharacterMentions(t, mentioned)
                : t).trim();
            if (/^[@/]/.test(stripped)) return true;
            return false;
        } catch {
            return true;
        }
    }
    return false;
}

// --- shared management command runner ---------------------------------------
// Pure logic + reply strings; the caller prints/sends `reply` and persists
// settings when `settingsChanged` is true. Handles @ or / prefixes.

export function runSecurityCommand(rawText, settings, scope) {
    const t = String(rawText || "").trim();
    const cmdText = t.startsWith("@") ? "/" + t.slice(1) : t;
    const lower = cmdText.toLowerCase();
    const s = settings || {};

    if (!isSecurityCommand(lower)) return { handled: false, reply: "", settingsChanged: false };

    const ttlMins = getUnlockTtlMinutes(s);
    const ttlDuration = formatUnlockDuration(ttlMins);
    const argText = cmdText.replace(/^\/[A-Za-z\-_]+/, "").trim();
    const args = argText ? argText.split(/\s+/) : [];

    // @set-security-pin <new-pin> [current-pin] (alias @set-pin)
    if (lower === "/set-security-pin" || lower.startsWith("/set-security-pin ") ||
        lower === "/set-pin" || lower.startsWith("/set-pin ")) {
        const newPin = args[0] || "";
        const currentPin = args[1] || "";
        if (!isSecurityPinSet(s)) {
            const res = setSecurityPin(s, newPin);
            if (!res.ok) return { handled: true, reply: res.message, settingsChanged: false };
            unlockScope(scope, s);
            return {
                handled: true,
                settingsChanged: true,
                reply: `🔒 Security PIN set (${res.pin.length} digits) and this surface is unlocked for ${ttlDuration}. All control commands now need @unlock <pin> after the unlock expires — regular chatting always works. Change it with @set-security-pin <new-pin>, remove it with @remove-security-pin <pin>.`,
            };
        }
        if (isScopeUnlocked(scope)) {
            const res = setSecurityPin(s, newPin);
            if (!res.ok) return { handled: true, reply: res.message, settingsChanged: false };
            unlockScope(scope, s);
            return { handled: true, settingsChanged: true, reply: `🔒 Security PIN changed (${res.pin.length} digits). This surface stays unlocked for ${ttlDuration}.` };
        }
        if (currentPin && verifySecurityPin(s, currentPin)) {
            const res = setSecurityPin(s, newPin);
            if (!res.ok) return { handled: true, reply: res.message, settingsChanged: false };
            unlockScope(scope, s);
            return { handled: true, settingsChanged: true, reply: `🔒 Security PIN changed (${res.pin.length} digits) and this surface is unlocked for ${ttlDuration}.` };
        }
        return {
            handled: true,
            settingsChanged: false,
            reply: currentPin
                ? `⛔ Wrong current PIN. Usage: @set-security-pin <new-pin> <current-pin> (or @unlock <current-pin> first, then @set-security-pin <new-pin>).`
                : `🔒 A security PIN is already set. To change it, @unlock <current-pin> first — or pass it inline: @set-security-pin <new-pin> <current-pin>.`,
        };
    }

    // @remove-security-pin [pin] (aliases: @clear/@disable/@unset-security-pin, @remove-pin)
    if (lower === "/remove-security-pin" || lower.startsWith("/remove-security-pin ") ||
        lower === "/clear-security-pin" || lower.startsWith("/clear-security-pin ") ||
        lower === "/disable-security-pin" || lower.startsWith("/disable-security-pin ") ||
        lower === "/unset-security-pin" || lower.startsWith("/unset-security-pin ") ||
        lower === "/remove-pin" || lower.startsWith("/remove-pin ")) {
        if (!isSecurityPinSet(s)) {
            return { handled: true, settingsChanged: false, reply: "🔓 No security PIN is set — control commands are already unprotected." };
        }
        const given = args[0] || "";
        if (isScopeUnlocked(scope) || (given && verifySecurityPin(s, given))) {
            clearSecurityPin(s);
            return { handled: true, settingsChanged: true, reply: "🔓 Security PIN removed — control commands are no longer protected. Set a new one anytime with @set-security-pin <6+ digits>." };
        }
        return {
            handled: true,
            settingsChanged: false,
            reply: given
                ? "⛔ Wrong PIN — the security PIN was NOT removed."
                : "🔒 To remove the PIN, @unlock <pin> first — or pass it inline: @remove-security-pin <pin>.",
        };
    }

    // @unlock <pin> (alias @unlock-pin) — OTP layer sits BEFORE unlock:
    // when OTP is enrolled, @otp-login must succeed first.
    if (lower === "/unlock" || lower.startsWith("/unlock ") ||
        lower === "/unlock-pin" || lower.startsWith("/unlock-pin ")) {
        if (!isSecurityPinSet(s)) {
            return { handled: true, settingsChanged: false, reply: "🔓 No security PIN is set — nothing to unlock. Set one with @set-security-pin <6+ digits>." };
        }
        if (isOtpSet(s) && !isOtpAuthenticated(scope)) {
            return { handled: true, settingsChanged: false, reply: "🔐 OTP required before @unlock — authenticate first with @otp-login <6-digit code from your authenticator app>." };
        }
        const given = args[0] || "";
        if (!given) {
            return { handled: true, settingsChanged: false, reply: "⚠️ Usage: @unlock <pin>" };
        }
        if (verifySecurityPin(s, given)) {
            unlockScope(scope, s);
            return { handled: true, settingsChanged: false, reply: `🔓 Unlocked for ${ttlDuration} — control commands are allowed on this surface. Re-lock anytime with @lock.` };
        }
        return { handled: true, settingsChanged: false, reply: "⛔ Wrong PIN — still locked." };
    }

    // @lock
    if (lower === "/lock" || lower.startsWith("/lock ")) {
        lockScope(scope);
        if (!isSecurityPinSet(s) && !isOtpSet(s)) {
            return { handled: true, settingsChanged: false, reply: "🔓 No security PIN or OTP is set — nothing to lock. Set a PIN with @set-security-pin <6+ digits> or enroll OTP with @otp-set." };
        }
        if (isOtpSet(s) && !isOtpAuthenticated(scope)) {
            return { handled: true, settingsChanged: false, reply: "🔒 Locked — control commands need @otp-login <code> first (and @unlock <pin> again if a PIN is set). Regular chatting still works." };
        }
        if (!isSecurityPinSet(s)) {
            return { handled: true, settingsChanged: false, reply: "🔓 No security PIN is set — PIN layer already open, but OTP is still required (@otp-lock to drop OTP auth). Set a PIN with @set-security-pin <6+ digits>." };
        }
        return { handled: true, settingsChanged: false, reply: "🔒 Locked — control commands need @unlock <pin> again. Regular chatting still works." };
    }

    // @security-status (aliases @security, @pin-status)
    const set = isSecurityPinSet(s);
    const unlocked = isScopeUnlocked(scope);
    const remaining = unlocked ? Math.max(1, Math.ceil(unlockRemainingMinutes(scope))) : 0;
    const remainingDuration = formatUnlockDuration(remaining);
    const otpSet = isOtpSet(s);
    const otpOk = isOtpAuthenticated(scope);
    const otpRemaining = otpOk ? Math.max(1, Math.ceil(otpRemainingMinutes(scope))) : 0;
    const otpRemainingDuration = formatUnlockDuration(otpRemaining);
    const otpBit = otpSet
        ? (otpOk ? `OTP: enrolled + authenticated (~${otpRemainingDuration} left, @otp-lock to drop). ` : `OTP: enrolled but NOT authenticated — @otp-login <code> first. `)
        : `OTP: not enrolled (@otp-set to enroll). `;
    return {
        handled: true,
        settingsChanged: false,
        reply: set
            ? (unlocked
                ? `🔒 Security PIN: set. This surface: unlocked (~${remainingDuration} left, @lock to re-lock). ${otpBit}Unlock duration: @set-setting security_unlock_minutes <1-1440> (needs unlock, currently ${unlockDurationInfo(s)}).`
                : `🔒 Security PIN: set. This surface: locked — @unlock <pin> to allow control commands (${unlockDurationInfo(s)} per unlock). ${otpBit}Regular chatting works without the PIN.`)
            : (otpSet
                ? `🔓 Security PIN: not set. ${otpBit}Control commands still need @otp-login.`
                : "🔓 Security PIN: not set — control commands are unprotected. Set one with @set-security-pin <6+ digits> (digits only)."),
    };
}

// --- OTP management command runner ------------------------------------------
// @otp-set / @otp-login / @otp-lock / @otp-remove / @otp-status.
// Pure logic + reply strings; the caller prints/sends `reply` and persists
// settings when `settingsChanged` is true. Handles @ or / prefixes.
// The OTP layer sits BEFORE @unlock: while OTP is enrolled, @unlock and
// every other control command stay locked until @otp-login succeeds.

export function runOtpCommand(rawText, settings, scope) {
    const t = String(rawText || "").trim();
    const cmdText = t.startsWith("@") ? "/" + t.slice(1) : t;
    const lower = cmdText.toLowerCase();
    const s = settings || {};

    if (!isOtpCommand(lower)) return { handled: false, reply: "", settingsChanged: false };

    const ttlDuration = formatUnlockDuration(s);
    const argText = cmdText.replace(/^\/[A-Za-z\-_]+/, "").trim();
    const args = argText ? argText.split(/\s+/) : [];

    // @otp-set [account] — enroll (or rotate) the authenticator secret.
    // First enroll when no OTP exists: needs PIN unlock if a PIN is set
    // (so a stranger can't enroll their own authenticator). Rotation when
    // OTP already exists: needs OTP auth + PIN unlock (if PIN set).
    if (lower === "/otp-set" || lower.startsWith("/otp-set ")) {
        const account = (args[0] || s.otp_account || "llama-chat").slice(0, 64);
        const issuer = String(s.otp_issuer || "LlamaChat").slice(0, 64) || "LlamaChat";
        if (isOtpSet(s)) {
            if (!isOtpAuthenticated(scope)) {
                return { handled: true, settingsChanged: false, reply: "🔐 OTP is already enrolled — authenticate first with @otp-login <code>, then re-run @otp-set to rotate the secret." };
            }
            if (isSecurityPinSet(s) && !isScopeUnlocked(scope)) {
                return { handled: true, settingsChanged: false, reply: "🔒 PIN unlock required too — run @unlock <pin> first, then re-run @otp-set to rotate the secret." };
            }
        } else if (isSecurityPinSet(s) && !isScopeUnlocked(scope)) {
            return { handled: true, settingsChanged: false, reply: "🔒 A security PIN is set — @unlock <pin> first, then run @otp-set to enroll OTP." };
        }
        const secret = generateOtpSecret();
        const res = setOtpSecret(s, secret, { account, issuer });
        if (!res.ok) return { handled: true, settingsChanged: false, reply: res.message };
        otpLoginScope(scope, s);
        const url = buildOtpAuthUrl(res.secret, { account, issuer });
        return {
            handled: true,
            settingsChanged: true,
            reply: `🔐 OTP enrolled for "${account}" — this surface is OTP-authenticated for ${ttlDuration}.\n\n1) Open Google Authenticator / Authy / 1Password and add this secret:\n   ${res.secret}\n\n2) Or scan/import this URL:\n   ${url}\n\n3) Then verify with @otp-login <6-digit code> on each surface (Telegram/WhatsApp/Web/CLI log in separately).\n\n⚠️ Anyone with this secret can generate codes — keep it private. Rotate anytime with @otp-set, remove with @otp-remove (needs @otp-login + @unlock).`,
        };
    }

    // @otp-login <code> — verify a 6-digit TOTP code for this surface.
    if (lower === "/otp-login" || lower.startsWith("/otp-login ")) {
        if (!isOtpSet(s)) {
            return { handled: true, settingsChanged: false, reply: "🔐 No OTP is enrolled — enroll with @otp-set first." };
        }
        const code = normalizeOtpCode(args[0] || "");
        if (!code) {
            return { handled: true, settingsChanged: false, reply: "⚠️ Usage: @otp-login <6-digit code from your authenticator app>" };
        }
        if (verifyOtpCode(s.otp_secret, code)) {
            otpLoginScope(scope, s);
            const needPin = isSecurityPinSet(s) && !isScopeUnlocked(scope);
            return {
                handled: true,
                settingsChanged: false,
                reply: needPin
                    ? `🔐 OTP accepted for ${ttlDuration} — now run @unlock <pin> to finish unlocking control commands.`
                    : `🔐 OTP accepted for ${ttlDuration} — control commands are allowed on this surface. Drop anytime with @otp-lock.`,
            };
        }
        return { handled: true, settingsChanged: false, reply: "⛔ Wrong or expired code — check your authenticator app clock and try the current 6-digit code." };
    }

    // @otp-lock — drop OTP authentication for this surface only.
    if (lower === "/otp-lock" || lower.startsWith("/otp-lock ")) {
        otpLockScope(scope);
        if (!isOtpSet(s)) {
            return { handled: true, settingsChanged: false, reply: "🔐 No OTP is enrolled — nothing to lock. Enroll with @otp-set." };
        }
        return { handled: true, settingsChanged: false, reply: "🔐 OTP locked on this surface — control commands need @otp-login <code> again (plus @unlock <pin> if a PIN is set). Regular chatting still works." };
    }

    // @otp-remove [code] — remove OTP enrollment. Requires BOTH layers:
    // OTP authentication (inline code accepted) AND PIN unlock (when a PIN
    // is set). This is the destructive step, so both factors are mandatory.
    if (lower === "/otp-remove" || lower.startsWith("/otp-remove ")) {
        if (!isOtpSet(s)) {
            return { handled: true, settingsChanged: false, reply: "🔐 No OTP is enrolled — nothing to remove." };
        }
        if (!isOtpAuthenticated(scope)) {
            const inline = normalizeOtpCode(args[0] || "");
            if (inline && verifyOtpCode(s.otp_secret, inline)) {
                otpLoginScope(scope, s);
            } else {
                return {
                    handled: true,
                    settingsChanged: false,
                    reply: inline
                        ? "⛔ Wrong or expired code — OTP was NOT removed."
                        : "🔐 To remove OTP, authenticate first: @otp-login <code> — or pass it inline: @otp-remove <code>.",
                };
            }
        }
        if (isSecurityPinSet(s) && !isScopeUnlocked(scope)) {
            return { handled: true, settingsChanged: false, reply: "🔒 PIN unlock required too — run @unlock <pin> (OTP already accepted), then re-run @otp-remove <code>." };
        }
        clearOtpSecret(s);
        otpLockAllScopes();
        return { handled: true, settingsChanged: true, reply: "🔐 OTP removed — control commands no longer need authenticator codes. Enroll again anytime with @otp-set." };
    }

    // @otp-status (alias @otp)
    const enrolled = isOtpSet(s);
    const authed = isOtpAuthenticated(scope);
    const left = authed ? Math.max(1, Math.ceil(otpRemainingMinutes(scope))) : 0;
    const leftDuration = formatUnlockDuration(left);
    return {
        handled: true,
        settingsChanged: false,
        reply: enrolled
            ? (authed
                ? `🔐 OTP: enrolled + authenticated on this surface (~${leftDuration} left, @otp-lock to drop). PIN layer: ${isSecurityPinSet(s) ? (isScopeUnlocked(scope) ? "unlocked" : "locked (@unlock <pin>)") : "not set"}. Unlock duration: ${unlockDurationInfo(s)}.`
                : `🔐 OTP: enrolled but NOT authenticated on this surface — @otp-login <code> to allow control commands (${unlockDurationInfo(s)} per login). Regular chatting works without it.`)
            : "🔐 OTP: not enrolled — control commands are not OTP-protected. Enroll with @otp-set (works with Google Authenticator and any TOTP app).",
    };
}
