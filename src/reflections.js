/**
 * Daily self-reflections — a separate memory bank beside memory.json.
 *
 * The bot writes its own reflections to `data/reflections.json` (one JSON
 * array, per-character scoped via `characterId`) after the user runs
 * `@insight`. Later turns recall relevant reflections by token-overlap
 * association and inject them as `[Relevant Self-Reflections]`, so the bot
 * can reference its own past reflections alongside persistent memories.
 *
 * Locking: `@insight*` words are registered in security.js CONTROL_WORDS,
 * so every surface (CLI / Telegram / WhatsApp / Web / Dashboard) refuses
 * them while PIN/OTP-locked via the standard isProbablyControlCommand gate.
 * The bridge handler below assumes the caller already passed the lock gate
 * (like simulations) — it does NOT re-check locks itself.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const REFLECTION_FILE = "data/reflections.json";
export const REFLECTION_DAILY_LIMIT = 1;

const STOP_WORDS = new Set([
    "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
    "of", "with", "by", "from", "up", "about", "into", "over", "after",
    "is", "am", "are", "was", "were", "be", "been", "being", "have", "has",
    "had", "do", "does", "did", "can", "could", "shall", "should", "will",
    "would", "it", "its", "what", "which", "who", "whom", "this", "that",
    "these", "those", "tell", "show", "me", "you", "i", "we", "they",
]);

function reflectionTokenize(text) {
    if (!text || typeof text !== "string") return [];
    return text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .split(/\s+/)
        .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
}

function nowIso() {
    return new Date().toISOString();
}

export function todayKey(date = new Date()) {
    const d = date instanceof Date ? date : new Date(date);
    return d.toISOString().slice(0, 10);
}

function ensureReflectionDir(filePath = REFLECTION_FILE) {
    const dir = path.dirname(filePath);
    if (dir && dir !== "." && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

export function loadReflections(filePath = REFLECTION_FILE) {
    try {
        if (!fs.existsSync(filePath)) return [];
        const raw = fs.readFileSync(filePath, "utf8");
        const data = JSON.parse(raw);
        const list = Array.isArray(data) ? data : (Array.isArray(data.reflections) ? data.reflections : []);
        return list.filter((r) => r && typeof r === "object");
    } catch {
        return [];
    }
}

function writeReflections(list, filePath = REFLECTION_FILE) {
    ensureReflectionDir(filePath);
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2), "utf8");
    fs.renameSync(tmp, filePath);
}

export function addReflection(input, { filePath = REFLECTION_FILE, characterId = null } = {}) {
    const payload = typeof input === "string" ? { content: input } : (input || {});
    const content = String(payload.content || payload.text || "").trim();
    if (!content) throw new Error("Reflection content cannot be empty.");
    const owner = payload.characterId ?? payload.character_id ?? characterId ?? null;
    const list = loadReflections(filePath);
    const entry = {
        id: payload.id || `ref_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`,
        date: payload.date || todayKey(),
        characterId: owner ? String(owner) : null,
        character_id: owner ? String(owner) : null,
        content,
        tags: Array.isArray(payload.tags) ? payload.tags : ["reflection", "insight"],
        source: payload.source || "insight",
        importance: typeof payload.importance === "number" ? payload.importance : 0.7,
        createdAt: payload.createdAt || nowIso(),
        updatedAt: nowIso(),
    };
    if (!entry.tags.includes("reflection")) entry.tags.push("reflection");
    list.push(entry);
    writeReflections(list, filePath);
    return entry;
}

export function listReflections({ characterId = null, limit = 20, filePath = REFLECTION_FILE } = {}) {
    let list = loadReflections(filePath);
    if (characterId) {
        const cid = String(characterId);
        list = list.filter((r) => !r.characterId || r.character_id === undefined || String(r.characterId || r.character_id || "") === "" || String(r.characterId ?? r.character_id ?? "") === cid);
        // Above keeps legacy unscoped rows visible; strictly-owned other rows are dropped.
        list = list.filter((r) => {
            const owner = r.characterId ?? r.character_id ?? null;
            return !owner || String(owner) === cid;
        });
    }
    list = list.slice().sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    if (limit) list = list.slice(0, limit);
    return list;
}

function scoreDocs(queryTokens, docs) {
    const docTokensList = docs.map((d) => Array.from(new Set(reflectionTokenize(d.text))));
    const df = new Map();
    for (const toks of docTokensList) {
        for (const t of toks) df.set(t, (df.get(t) ?? 0) + 1);
    }
    const N = Math.max(docs.length, 1);
    const scored = [];
    docs.forEach((doc, idx) => {
        const toks = docTokensList[idx];
        let s = 0;
        const matched = [];
        for (const q of queryTokens) {
            if (toks.includes(q)) {
                matched.push(q);
                const d = df.get(q) || 1;
                s += Math.log((N + 1) / d) + 1;
            }
        }
        if (matched.length > 0) scored.push({ ...doc, score: s * (doc.boost || 1), matchedTokens: matched });
    });
    scored.sort((a, b) => b.score - a.score);
    return scored;
}

/**
 * Association search over the reflection bank. Returns ONLY genuine token
 * matches (no fallback) so normal chat stays clean unless the prompt
 * genuinely connects to a past reflection.
 */
export function searchReflections(query, { characterId = null, limit = 3, filePath = REFLECTION_FILE } = {}) {
    const q = String(query || "").trim();
    if (!q) return listReflections({ characterId, limit, filePath }).map((r) => ({ kind: "reflection", text: r.content, reflection: r, score: 1 }));
    const queryTokens = reflectionTokenize(q);
    if (queryTokens.length === 0) return [];
    let pool = loadReflections(filePath);
    if (characterId) {
        const cid = String(characterId);
        pool = pool.filter((r) => {
            const owner = r.characterId ?? r.character_id ?? null;
            return !owner || String(owner) === cid;
        });
    }
    const docs = pool.map((r) => ({
        kind: "reflection",
        text: `${r.content} ${(r.tags || []).join(" ")} ${r.date || ""}`,
        reflection: r,
        boost: 1.0,
    }));
    if (docs.length === 0) return [];
    return scoreDocs(queryTokens, docs).slice(0, limit);
}

export function formatReflectionBlock(results) {
    if (!results || results.length === 0) return "";
    const lines = results.map((r) => {
        const ref = r.reflection || {};
        const text = String(ref.content || r.text || "").replace(/\s+/g, " ").trim().slice(0, 280);
        const when = ref.date || "";
        return `• [${when}] ${text}`;
    });
    return `[Relevant Self-Reflections — the bot's own past daily insights; use only when the association genuinely fits]:\n${lines.join("\n")}`;
}

export function formatReflectionList(list) {
    if (!list || list.length === 0) return "🪞 No reflections yet. Generate one with @insight.";
    const lines = [`🪞 Reflections (${list.length}):`];
    list.forEach((r, i) => {
        const excerpt = String(r.content || "").replace(/\s+/g, " ").trim().slice(0, 160);
        lines.push(`  ${i + 1}. [${r.date || "?"}] [${r.id}] ${excerpt}`);
    });
    return lines.join("\n");
}

/**
 * Parse @insight family commands. Accepts @ or / prefix, case-insensitive.
 * Returns null when the input is NOT an insight command.
 *
 *  @insight [optional focus]  — generate & save today's reflection
 *  @insights [N] / @insight-list — list recent reflections
 *  @insight-search <query>    — search the reflection bank
 *  @insight-show <id|YYYY-MM-DD> — show one reflection
 *  @insight-delete <id>       — delete one reflection
 */
export function parseInsightCommand(rawInput) {
    const raw = String(rawInput || "").trim();
    if (!raw) return null;
    const norm = raw.startsWith("@") ? "/" + raw.slice(1) : raw;
    const lower = norm.toLowerCase();
    if (!lower.startsWith("/insight")) return null;

    let m;
    if ((m = norm.match(/^\/(insight)[-_]search\b\s*(.*)$/i))) return { action: "search", query: (m[2] || "").trim() };
    if ((m = norm.match(/^\/(insight)[-_]show\b\s*(.*)$/i))) return { action: "show", target: (m[2] || "").trim() };
    if ((m = norm.match(/^\/(insight)[-_](list|history|log)\b\s*(.*)$/i))) {
        const n = parseInt(String(m[3] || "").trim(), 10);
        return { action: "list", limit: Number.isFinite(n) && n > 0 ? Math.min(n, 100) : 10 };
    }
    if ((m = norm.match(/^\/(insight)[-_]delete\b\s*(.*)$/i))) return { action: "delete", target: (m[2] || "").trim() };
    if (/^\/(insights)\b/i.test(norm)) {
        const rest = norm.replace(/^\/(insights)\b/i, "").trim();
        const n = parseInt(rest, 10);
        return { action: "list", limit: Number.isFinite(n) && n > 0 ? Math.min(n, 100) : 10 };
    }
    if (/^\/(insight)[-_]status\b/i.test(lower)) return { action: "status" };
    // Bare "@insight ..." with a sub-word: "search/show/list/delete/status"
    {
        const after = norm.replace(/^\/(insight)\b/i, "").trim();
        if (!after) return { action: "generate", focus: "" };
        const al = after.toLowerCase();
        if (/^(search)\b/i.test(al)) return { action: "search", query: after.replace(/^search\b/i, "").trim() };
        if (/^(show|get|view)\b/i.test(al)) return { action: "show", target: after.replace(/^(show|get|view)\b/i, "").trim() };
        if (/^(list|history|log|s)\b/i.test(al)) {
            const rest = after.replace(/^(list|history|log|s)\b/i, "").trim();
            const n = parseInt(rest, 10);
            return { action: "list", limit: Number.isFinite(n) && n > 0 ? Math.min(n, 100) : 10 };
        }
        if (/^(delete|remove|rm|del)\b/i.test(al)) return { action: "delete", target: after.replace(/^(delete|remove|rm|del)\b/i, "").trim() };
        if (/^status\b/i.test(al)) return { action: "status" };
        return { action: "generate", focus: after };
    }
}

/**
 * Build a daily reflection with the active LLM, then save it to the
 * reflection bank. Falls back to a deterministic template when the LLM is
 * unreachable so @insight never fails silently.
 */
export async function generateDailyReflection({
    settings = {},
    characterId = null,
    personaName = "",
    focus = "",
    ollamaClient = null,
    unifiedChatFn = null,
    filePath = REFLECTION_FILE,
} = {}) {
    const cid = characterId ? String(characterId) : null;
    const today = todayKey();
    const existing = listReflections({ characterId: cid, limit: 100, filePath });
    if (existing.some((r) => r.date === today)) {
        // One reflection per character per day keeps the bank a *daily* journal.
        // A second run on the same day refreshes the entry instead of duplicating it.
        const dup = existing.find((r) => r.date === today);
        try {
            const list = loadReflections(filePath);
            const idx = list.findIndex((r) => r.id === dup.id);
            if (idx >= 0) list.splice(idx, 1);
            writeReflections(list, filePath);
        } catch {}
    }

    // Gather grounding: recent memories + today's session turns.
    let memoryLines = [];
    let sessionLines = [];
    try {
        const mem = await import("./memory.js");
        const store = mem.getMemoryStore(cid || null);
        const recent = store.getActiveMemories ? store.getActiveMemories(cid || undefined, {}).slice(0, 12) : [];
        memoryLines = recent.map((x) => `• [${x.type || "fact"}] ${String(x.content || "").slice(0, 200)}`);
    } catch {}
    try {
        const sess = await import("./sessions.js");
        const all = sess.listSessions ? sess.listSessions(cid || undefined) : [];
        const turns = [];
        for (const s of (all || []).slice(0, 3)) {
            const full = sess.loadSession ? sess.loadSession(s.id, cid || undefined) : null;
            const msgs = (full && full.messages) || s.messages || [];
            for (const msg of msgs.slice(-8)) {
                if (msg.role === "user" || msg.role === "assistant") {
                    turns.push(`${msg.role}: ${String(msg.content || "").slice(0, 160)}`);
                    if (turns.length >= 12) break;
                }
            }
            if (turns.length >= 12) break;
        }
        sessionLines = turns;
    } catch {}

    const who = personaName || cid || "assistant";
    const focusLine = focus ? `Focus requested by user: "${focus}".\n` : "";
    const prompt = `You are ${who}, writing a private daily self-reflection journal entry for ${today}.\n${focusLine}Review these recent memories:\n${memoryLines.join("\n") || "(no memories yet)"}\n\nAnd these recent conversation turns:\n${sessionLines.join("\n") || "(no recent turns)"}\n\nWrite 3-6 concise bullets: what mattered today, what you learned about the user, what to remember tomorrow, and one thing to improve. Plain text, no preamble, under 150 words.`;

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
                { role: "system", content: `You are ${who}. Write honest, compact daily self-reflections.` },
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
        const memBit = memoryLines.length > 0 ? `${memoryLines.length} active memorie(s) reviewed` : "memory bank is still empty";
        const sessBit = sessionLines.length > 0 ? `${sessionLines.length} recent turn(s) reviewed` : "no recent turns";
        text = `Daily reflection (${today}) — ${who}: ${memBit}; ${sessBit}.${focus ? ` Focus: ${focus}.` : ""} Keep continuity tomorrow: re-read this entry before answering.`;
    }
    // Cap length so the bank stays a journal, not a dump.
    if (text.length > 2000) text = text.slice(0, 2000).trim();

    return addReflection(
        { content: text, characterId: cid, tags: ["reflection", "insight", `date:${today}`], source: "insight", importance: 0.7, date: today },
        { filePath, characterId: cid }
    );
}

export function deleteReflection(target, { characterId = null, filePath = REFLECTION_FILE } = {}) {
    const t = String(target || "").trim();
    if (!t) return { success: false, message: "Usage: @insight-delete <id|YYYY-MM-DD|number>" };
    const list = loadReflections(filePath);
    let pool = list;
    if (characterId) {
        const cid = String(characterId);
        pool = pool.filter((r) => {
            const owner = r.characterId ?? r.character_id ?? null;
            return !owner || String(owner) === cid;
        });
    }
    // By 1-based recency index, id, or date.
    let found = null;
    const num = parseInt(t, 10);
    const sorted = pool.slice().sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    if (!isNaN(num) && num >= 1 && num <= sorted.length && !t.includes("-")) found = sorted[num - 1];
    if (!found) found = pool.find((r) => r.id === t);
    if (!found) found = pool.find((r) => r.date === t);
    if (!found) return { success: false, message: `Reflection '${t}' not found.` };
    const next = list.filter((r) => r.id !== found.id);
    writeReflections(next, filePath);
    return { success: true, removed: found };
}

/**
 * Shared bridge handler for Telegram / WhatsApp / Web / Dashboard / CLI.
 * Returns { handled, reply }. Caller prints/sends `reply`.
 * Generation needs settings (+ optional ollamaClient/unifiedChatFn).
 */
export async function handleReflectionBridgeCommand(rawInput, {
    characterId = null,
    personaName = "",
    settings = {},
    ollamaClient = null,
    unifiedChatFn = null,
    filePath = REFLECTION_FILE,
} = {}) {
    const parsed = parseInsightCommand(rawInput);
    if (!parsed) return { handled: false, reply: null };
    const cid = characterId ? String(characterId) : null;

    if (parsed.action === "list") {
        const list = listReflections({ characterId: cid, limit: parsed.limit || 10, filePath });
        return { handled: true, reply: formatReflectionList(list) };
    }
    if (parsed.action === "search") {
        const q = (parsed.query || "").trim();
        if (!q) return { handled: true, reply: "⚠️ Usage: @insight-search <query>" };
        const hits = searchReflections(q, { characterId: cid, limit: 8, filePath });
        if (hits.length === 0) return { handled: true, reply: `🪞 No reflections match "${q}".` };
        return { handled: true, reply: formatReflectionBlock(hits) };
    }
    if (parsed.action === "show") {
        const t = (parsed.target || "").trim();
        if (!t) {
            const latest = listReflections({ characterId: cid, limit: 1, filePath })[0];
            if (!latest) return { handled: true, reply: "🪞 No reflections yet. Generate one with @insight." };
            return { handled: true, reply: `🪞 [${latest.date}] [${latest.id}]\n${latest.content}` };
        }
        const pool = listReflections({ characterId: cid, limit: 1000, filePath });
        let found = pool.find((r) => r.id === t) || pool.find((r) => r.date === t);
        if (!found) {
            const num = parseInt(t, 10);
            if (!isNaN(num) && num >= 1 && num <= pool.length) found = pool[num - 1];
        }
        if (!found) return { handled: true, reply: `⚠️ Reflection '${t}' not found.` };
        return { handled: true, reply: `🪞 [${found.date}] [${found.id}]\n${found.content}` };
    }
    if (parsed.action === "delete") {
        const res = deleteReflection(parsed.target, { characterId: cid, filePath });
        return { handled: true, reply: res.success ? `🗑 Reflection [${res.removed.id}] deleted.` : `⚠️ ${res.message}` };
    }
    if (parsed.action === "status") {
        const list = listReflections({ characterId: cid, limit: 1000, filePath });
        const latest = list[0];
        return {
            handled: true,
            reply: `🪞 Reflections: ${list.length} stored for "${personaName || cid || "shared"}" in ${filePath}.${latest ? ` Latest: [${latest.date}] ${String(latest.content || "").slice(0, 120)}` : " None yet — run @insight to write today's entry."}`,
        };
    }
    // generate
    try {
        const entry = await generateDailyReflection({
            settings, characterId: cid, personaName, focus: parsed.focus || "",
            ollamaClient, unifiedChatFn, filePath,
        });
        return { handled: true, reply: `🪞 Daily reflection saved [${entry.date}] [${entry.id}]:\n${entry.content}` };
    } catch (err) {
        return { handled: true, reply: `⚠️ @insight error: ${err.message || err}` };
    }
}

/**
 * Shared augmentation for chat pipelines: relevant past reflections as a
 * ready-to-inject system block (empty string when nothing matches).
 */
export function getReflectionChatAugmentation(query, { characterId = null, limit = 3, filePath = REFLECTION_FILE } = {}) {
    try {
        const hits = searchReflections(query, { characterId, limit, filePath });
        if (!hits || hits.length === 0) return { hits: [], block: "" };
        return { hits, block: formatReflectionBlock(hits) };
    } catch {
        return { hits: [], block: "" };
    }
}
