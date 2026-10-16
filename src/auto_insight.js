/**
 * Adaptive auto-insight — self-referential association layer on top of
 * data/reflections.json.
 *
 * Manual `@insight` stays daily (one entry per character per day). This module
 * adds a background micro-layer: every N *substantive* turns (default 8) +
 * cooldown gate, a small 1-2 bullet self-observation is generated
 * asynchronously (never blocks the reply) and stored with
 * source:"auto-insight". Later turns recall it via the same association
 * search (`searchReflections` / `getReflectionChatAugmentation`), so the bot
 * references its own past insights alongside memories/knowledge/sessions.
 *
 * Wiring: call `maybeAutoInsight()` fire-and-forget after a completed
 * exchange on every surface (CLI / Telegram / WhatsApp / voice / dashboard),
 * right next to `learningPipeline.extractWithLLM(...).catch(...)`.
 * Control plane: `@insight-auto [on|off|status|every <n>]`.
 */

import fs from "node:fs";
import path from "node:path";

export const AUTO_INSIGHT_STATE_FILE = "data/auto_insight.json";

export const AUTO_INSIGHT_DEFAULTS = {
    enabled: true,
    everyN: 8,
    cooldownMinutes: 30,
    minChars: 24,
    maxPerDay: 6,
};

function numOrFallback(v, fb) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : fb;
}

export function getAutoInsightConfig(settings = {}) {
    const pickPositive = (v, fb) => {
        const n = Number(v);
        return Number.isFinite(n) && n > 0 ? n : fb;
    };
    const pickNonNegative = (v, fb) => {
        const n = Number(v);
        return Number.isFinite(n) && n >= 0 ? n : fb;
    };
    return {
        enabled: settings.insight_auto_enabled ?? AUTO_INSIGHT_DEFAULTS.enabled,
        everyN: pickPositive(settings.insight_auto_every_n, AUTO_INSIGHT_DEFAULTS.everyN),
        cooldownMinutes: pickNonNegative(settings.insight_auto_cooldown_minutes, AUTO_INSIGHT_DEFAULTS.cooldownMinutes),
        minChars: pickPositive(settings.insight_auto_min_chars, AUTO_INSIGHT_DEFAULTS.minChars),
        maxPerDay: pickPositive(settings.insight_auto_max_per_day, AUTO_INSIGHT_DEFAULTS.maxPerDay),
    };
}

export function todayKey(date = new Date()) {
    const d = date instanceof Date ? date : new Date(date);
    return d.toISOString().slice(0, 10);
}

function ensureDir(filePath) {
    const dir = path.dirname(filePath);
    if (dir && dir !== "." && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function loadAutoInsightState(filePath = AUTO_INSIGHT_STATE_FILE) {
    try {
        if (!fs.existsSync(filePath)) return { counters: {} };
        const raw = fs.readFileSync(filePath, "utf8");
        const data = JSON.parse(raw);
        if (data && typeof data === "object" && data.counters && typeof data.counters === "object") return data;
        return { counters: {} };
    } catch {
        return { counters: {} };
    }
}

function writeState(state, filePath = AUTO_INSIGHT_STATE_FILE) {
    ensureDir(filePath);
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
    fs.renameSync(tmp, filePath);
}

function charKey(characterId) {
    return characterId ? String(characterId) : "shared";
}

const TRIVIAL_EXACT = new Set([
    "ok", "okay", "k", "yes", "no", "yeah", "yep", "nope",
    "thanks", "thank you", "thx", "ty", "hi", "hello", "hey",
    "bye", "good morning", "good night", "lol", "haha",
]);

/**
 * Substantive = long enough, not a @ command, not trivial chitchat.
 * Deliberately dependency-free (needle.js has the same idea but heavier).
 */
export function isSubstantiveTurn(text, minChars = AUTO_INSIGHT_DEFAULTS.minChars) {
    const t = String(text || "").trim();
    if (!t) return false;
    if (/^[@/]/.test(t)) return false;
    if (t.length < minChars) return false;
    const lower = t.toLowerCase().replace(/[.!?,;:\s]+$/g, "");
    if (TRIVIAL_EXACT.has(lower)) return false;
    if (lower.length < 8 && /^(ok|yes|no|thanks|hi|hey)\b/.test(lower)) return false;
    return true;
}

function dailyCount(counter, today) {
    try {
        return Number(counter?.dailyCounts?.[today] || 0);
    } catch {
        return 0;
    }
}

/**
 * Record one completed exchange. Returns { shouldRun, reason, state }.
 * Persists the counter so restarts don't reset the cadence.
 * Pure gate — generation happens in maybeAutoInsight().
 */
export function recordTurnAndCheck({
    characterId = null,
    userText = "",
    settings = {},
    nowMs = Date.now(),
    filePath = AUTO_INSIGHT_STATE_FILE,
} = {}) {
    const cfg = getAutoInsightConfig(settings);
    const state = loadAutoInsightState(filePath);
    const key = charKey(characterId);
    const counter = state.counters[key] || { turnsSinceLast: 0, lastRunAt: 0, dailyCounts: {} };
    if (!cfg.enabled) return { shouldRun: false, reason: "disabled", state };
    if (!isSubstantiveTurn(userText, cfg.minChars)) return { shouldRun: false, reason: "trivial", state };

    counter.turnsSinceLast = (counter.turnsSinceLast || 0) + 1;
    const today = todayKey(new Date(nowMs));
    const runsToday = dailyCount(counter, today);
    let shouldRun = false;
    let reason = `waiting (${counter.turnsSinceLast}/${cfg.everyN})`;

    if (counter.turnsSinceLast >= cfg.everyN) {
        const sinceLast = nowMs - (counter.lastRunAt || 0);
        if (counter.lastRunAt && sinceLast < cfg.cooldownMinutes * 60 * 1000) {
            reason = "cooldown";
        } else if (runsToday >= cfg.maxPerDay) {
            reason = "daily-cap";
        } else {
            shouldRun = true;
            reason = "due";
            counter.turnsSinceLast = 0;
            counter.lastRunAt = nowMs;
            counter.dailyCounts = { ...(counter.dailyCounts || {}), [today]: runsToday + 1 };
        }
    }
    state.counters[key] = counter;
    writeState(state, filePath);
    return { shouldRun, reason, state };
}

/**
 * Build a 1-2 bullet micro self-observation and store it in the reflection
 * bank (source:"auto-insight"). Unlike the daily entry this never dedups —
 * several micro-entries per day are expected.
 */
export async function generateAutoInsight({
    settings = {},
    characterId = null,
    personaName = "",
    sessionMessages = [],
    ollamaClient = null,
    unifiedChatFn = null,
    filePath = undefined,
} = {}) {
    const cid = characterId ? String(characterId) : null;
    const recent = (sessionMessages || []).slice(-8)
        .filter((m) => m && (m.role === "user" || m.role === "assistant"))
        .map((m) => `${m.role}: ${String(m.content || "").slice(0, 220)}`)
        .join("\n")
        .slice(0, 2000);

    const who = personaName || cid || "assistant";
    const prompt = `You are ${who}, writing a brief private self-observation (1-2 bullets, under 60 words) about this conversation so far.\nCapture: one thing you learned about the user + one thing to carry into future replies. Plain text, no preamble.\n\nRecent exchange:\n${recent || "(no turns yet)"}`;

    let text = "";
    try {
        let chatFn = unifiedChatFn;
        if (!chatFn) {
            const prov = await import("./providers.js");
            chatFn = prov.unifiedChat;
        }
        if (!chatFn) throw new Error("no chat fn");
        const res = await chatFn({
            modelName: settings.model,
            messages: [
                { role: "system", content: `You are ${who}. Write compact self-observations for future continuity.` },
                { role: "user", content: prompt },
            ],
            stream: false,
            settings,
            ollamaClient,
        });
        text = String(res && res.content ? res.content : "").trim();
    } catch {
        text = "";
    }
    if (!text) {
        text = `• Noted ongoing thread with user; carry forward context into next replies.`;
    }
    if (text.length > 800) text = text.slice(0, 800).trim();

    const { addReflection, todayKey: refToday } = await import("./reflections.js");
    return addReflection(
        {
            content: text,
            characterId: cid,
            tags: ["reflection", "auto-insight", `date:${refToday()}`],
            source: "auto-insight",
            importance: 0.55,
            date: refToday(),
        },
        { filePath, characterId: cid },
    );
}

/**
 * Fire-and-forget entry point for chat pipelines. Never throws, never blocks
 * the reply — caller must NOT await it in the hot path:
 *   maybeAutoInsight({...}).catch(() => {});
 * Returns the saved entry or null.
 */
export async function maybeAutoInsight({
    settings = {},
    characterId = null,
    personaName = "",
    userText = "",
    sessionMessages = [],
    ollamaClient = null,
    unifiedChatFn = null,
    filePath = undefined,
    statePath = AUTO_INSIGHT_STATE_FILE,
    nowMs = Date.now(),
} = {}) {
    try {
        const gate = recordTurnAndCheck({ characterId, userText, settings, nowMs, filePath: statePath });
        if (!gate.shouldRun) return null;
        const entry = await generateAutoInsight({
            settings, characterId, personaName, sessionMessages,
            ollamaClient, unifiedChatFn, filePath,
        });
        try {
            const { getBotDatabase } = await import("./db/database.js");
            getBotDatabase().logLearningEvent("auto_insight", { characterId: characterId || "shared", id: entry?.id || null });
        } catch {}
        return entry;
    } catch {
        return null;
    }
}

/**
 * Parse `@insight-auto` control command. Accepts @ or / prefix.
 *   @insight-auto / @insight-auto status / @insight-auto on|off
 *   @insight-auto every <n> / @insight-auto cooldown <mins>
 */
export function parseAutoInsightCommand(rawInput) {
    const raw = String(rawInput || "").trim();
    if (!raw) return null;
    const norm = raw.startsWith("@") ? "/" + raw.slice(1) : raw;
    if (!/^\/insight-auto\b/i.test(norm)) return null;
    const rest = norm.replace(/^\/insight-auto\b/i, "").trim();
    if (!rest) return { action: "status" };
    const lower = rest.toLowerCase();
    if (/^status\b/.test(lower) || lower === "s") return { action: "status" };
    if (/^(on|enable|enabled|1|true)\b/.test(lower)) return { action: "on" };
    if (/^(off|disable|disabled|0|false)\b/.test(lower)) return { action: "off" };
    let m;
    if ((m = rest.match(/^every\s+(\d+)/i))) return { action: "every", value: Math.max(1, Math.min(50, parseInt(m[1], 10))) };
    if ((m = rest.match(/^cooldown\s+(\d+)/i))) return { action: "cooldown", value: Math.max(1, Math.min(1440, parseInt(m[1], 10))) };
    if ((m = rest.match(/^(\d+)\s*$/))) return { action: "every", value: Math.max(1, Math.min(50, parseInt(m[1], 10))) };
    return { action: "status" };
}

export function formatAutoInsightStatus(settings = {}, statePath = AUTO_INSIGHT_STATE_FILE) {
    const cfg = getAutoInsightConfig(settings);
    let extra = "";
    try {
        const st = loadAutoInsightState(statePath);
        const keys = Object.keys(st.counters || {});
        if (keys.length > 0) {
            extra = " Counters: " + keys.map((k) => {
                const c = st.counters[k];
                return `${k}: ${c.turnsSinceLast || 0}/${cfg.everyN}`;
            }).join("; ");
        }
    } catch {}
    return `🪞 Auto-insight: ${cfg.enabled ? "ON" : "OFF"} — every ${cfg.everyN} substantive turn(s) (≥${cfg.minChars} chars, not trivial/commands), cooldown ${cfg.cooldownMinutes}m, max ${cfg.maxPerDay}/day.${extra} Commands: @insight-auto on|off|every <n>|cooldown <mins>`;
}

export async function handleAutoInsightCommand(rawInput, { settings = {}, persist = null, statePath = AUTO_INSIGHT_STATE_FILE } = {}) {
    const parsed = parseAutoInsightCommand(rawInput);
    if (!parsed) return { handled: false, reply: null };
    const save = typeof persist === "function" ? persist : () => {};
    if (parsed.action === "status") {
        return { handled: true, reply: formatAutoInsightStatus(settings, statePath) };
    }
    if (parsed.action === "on") {
        settings.insight_auto_enabled = true;
        try { save(settings); } catch {}
        return { handled: true, reply: `🪞 Auto-insight enabled (every ${getAutoInsightConfig(settings).everyN} substantive turns).`, settingsChanged: true };
    }
    if (parsed.action === "off") {
        settings.insight_auto_enabled = false;
        try { save(settings); } catch {}
        return { handled: true, reply: "🪞 Auto-insight disabled. Manual @insight still works.", settingsChanged: true };
    }
    if (parsed.action === "every") {
        settings.insight_auto_every_n = parsed.value;
        try { save(settings); } catch {}
        return { handled: true, reply: `🪞 Auto-insight cadence set to every ${parsed.value} substantive turn(s).`, settingsChanged: true };
    }
    if (parsed.action === "cooldown") {
        settings.insight_auto_cooldown_minutes = parsed.value;
        try { save(settings); } catch {}
        return { handled: true, reply: `🪞 Auto-insight cooldown set to ${parsed.value} minute(s).`, settingsChanged: true };
    }
    return { handled: true, reply: formatAutoInsightStatus(settings, statePath) };
}
