/**
 * Simulation mode — a simple separate chat thread inside the existent persona.
 *
 * Each simulation runs as normal chat with the active character persona
 * (persona prompt stays the same; an optional scenario is just a loose
 * background note, not strict rules), and owns its own archive file
 * in `data/simulations/<slug>.json` where its chats + memories are stored.
 *
 * Lifecycle:
 *   @simulation <name> [| <optional note>] — start/resume
 *   @simulation-end | @simulation-stop | @simulation-passed | @simulation-pass
 *   (also `@simulation end|stop|passed|...`) — archive & end
 *
 * While a simulation is active for a scope (platform:character:chat), chat
 * turns are stored ONLY in the simulation archive (not in the global memory
 * DB), keeping each thread separate. When idle, relevant archive
 * entries are recalled via token-overlap association matching and injected
 * as `[Relevant Simulation Archives]`.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const SIM_DIR = "data/simulations";
export const SIM_STATE_FILE = "data/simulation_state.json";

const STOP_WORDS = new Set([
    "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
    "of", "with", "by", "from", "up", "about", "into", "over", "after",
    "is", "am", "are", "was", "were", "be", "been", "being", "have", "has",
    "had", "do", "does", "did", "can", "could", "shall", "should", "will",
    "would", "it", "its", "what", "which", "who", "whom", "this", "that",
    "these", "those", "tell", "show", "me", "you", "i", "we", "they",
]);

function simTokenize(text) {
    if (!text || typeof text !== "string") return [];
    return text
        .toLowerCase()
        .replace(/[^\w\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
}

export function sanitizeSimulationName(name) {
    const raw = String(name || "").trim().toLowerCase();
    if (!raw) return "sim";
    const slug = raw
        .replace(/[^a-z0-9-_]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 64);
    return slug || "sim";
}

export function simulationFilePath(nameOrSlug, dir = SIM_DIR) {
    return path.join(dir, `${sanitizeSimulationName(nameOrSlug)}.json`);
}

export function ensureSimDir(dir = SIM_DIR) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function nowIso() {
    return new Date().toISOString();
}

export function scopeKeyFor(platform = "cli", characterId = "main", chatId = "default") {
    const p = String(platform || "cli").trim().toLowerCase() || "cli";
    const c = String(characterId || "main").trim() || "main";
    const h = String(chatId ?? "default").trim() || "default";
    return `${p}:${c}:${h}`;
}

export function cliScopeKey(characterId) {
    return scopeKeyFor("cli", characterId, "cli");
}

// ---------- state (scope -> active slug) ----------

export function loadSimState(stateFile = SIM_STATE_FILE) {
    try {
        if (!fs.existsSync(stateFile)) return { scopes: {} };
        const data = JSON.parse(fs.readFileSync(stateFile, "utf8"));
        if (data && typeof data === "object" && data.scopes && typeof data.scopes === "object") return data;
        return { scopes: {} };
    } catch {
        return { scopes: {} };
    }
}

function saveSimState(state, stateFile = SIM_STATE_FILE) {
    try {
        const dir = path.dirname(stateFile);
        if (dir && dir !== "." && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const tmp = `${stateFile}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
        fs.renameSync(tmp, stateFile);
    } catch {}
}

export function getActiveSimulationName(scopeKey, stateFile = SIM_STATE_FILE) {
    const state = loadSimState(stateFile);
    const slug = state.scopes?.[scopeKey];
    return typeof slug === "string" && slug ? slug : null;
}

function setActiveSimulationName(scopeKey, slug, stateFile = SIM_STATE_FILE) {
    const state = loadSimState(stateFile);
    state.scopes = state.scopes || {};
    state.scopes[scopeKey] = slug;
    saveSimState(state, stateFile);
}

function clearActiveSimulationName(scopeKey, stateFile = SIM_STATE_FILE) {
    const state = loadSimState(stateFile);
    if (state.scopes) delete state.scopes[scopeKey];
    saveSimState(state, stateFile);
}

// ---------- archive files ----------

export function loadSimulation(nameOrSlug, dir = SIM_DIR) {
    const fp = simulationFilePath(nameOrSlug, dir);
    if (!fs.existsSync(fp)) return null;
    try {
        const data = JSON.parse(fs.readFileSync(fp, "utf8"));
        if (!data || typeof data !== "object") return null;
        if (!Array.isArray(data.messages)) data.messages = [];
        if (!Array.isArray(data.memories)) data.memories = [];
        return data;
    } catch {
        return null;
    }
}

function writeSimulation(sim, dir = SIM_DIR) {
    ensureSimDir(dir);
    sim.updatedAt = nowIso();
    const fp = simulationFilePath(sim.slug || sim.name, dir);
    const tmp = `${fp}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(sim, null, 2), "utf8");
    fs.renameSync(tmp, fp);
    return sim;
}

export function listSimulations({ characterId = null, dir = SIM_DIR } = {}) {
    ensureSimDir(dir);
    let files = [];
    try {
        files = fs.readdirSync(dir).filter((f) => f.endsWith(".json") && !f.endsWith(".tmp"));
    } catch {
        return [];
    }
    const out = [];
    for (const f of files) {
        try {
            const data = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
            if (!data || typeof data !== "object" || !data.slug) continue;
            if (characterId && data.characterId && data.characterId !== characterId) continue;
            out.push({
                name: data.name,
                slug: data.slug,
                characterId: data.characterId || null,
                personaName: data.personaName || "",
                status: data.status || "archived",
                scenario: data.scenario || "",
                exchanges: Math.floor((data.messages || []).length / 2),
                messages: (data.messages || []).length,
                memories: (data.memories || []).length,
                createdAt: data.createdAt || "",
                updatedAt: data.updatedAt || "",
                endedAt: data.endedAt || null,
            });
        } catch {}
    }
    return out.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
}

export function getActiveSimulation(scopeKey, { dir = SIM_DIR, stateFile = SIM_STATE_FILE } = {}) {
    const slug = getActiveSimulationName(scopeKey, stateFile);
    if (!slug) return null;
    const sim = loadSimulation(slug, dir);
    if (!sim || sim.status !== "active") {
        // Stale pointer — clean it.
        try { clearActiveSimulationName(scopeKey, stateFile); } catch {}
        return null;
    }
    return sim;
}

export function startSimulation({ name, scenario = "", characterId = "main", personaName = "", scopeKey, dir = SIM_DIR, stateFile = SIM_STATE_FILE }) {
    const cleanName = String(name || "").trim();
    if (!cleanName) throw new Error("Simulation name is required.");
    const slug = sanitizeSimulationName(cleanName);
    ensureSimDir(dir);
    let sim = loadSimulation(slug, dir);
    const scen = String(scenario || "").trim();
    if (sim) {
        // Resume existing archive (keeps its chats + memories).
        sim.status = "active";
        sim.characterId = characterId || sim.characterId || null;
        if (personaName) sim.personaName = personaName;
        if (scen) sim.scenario = scen;
        sim.endedAt = null;
        writeSimulation(sim, dir);
    } else {
        const now = nowIso();
        sim = {
            name: cleanName,
            slug,
            characterId: characterId || null,
            personaName: personaName || "",
            scenario: scen,
            status: "active",
            createdAt: now,
            updatedAt: now,
            endedAt: null,
            messages: [],
            memories: [],
        };
        writeSimulation(sim, dir);
    }
    if (scopeKey) setActiveSimulationName(scopeKey, slug, stateFile);
    return loadSimulation(slug, dir);
}

export function endSimulation(scopeKey, { dir = SIM_DIR, stateFile = SIM_STATE_FILE } = {}) {
    const sim = getActiveSimulation(scopeKey, { dir, stateFile });
    if (!sim) return null;
    sim.status = "archived";
    sim.endedAt = nowIso();
    writeSimulation(sim, dir);
    clearActiveSimulationName(scopeKey, stateFile);
    return sim;
}

export function deleteSimulation(nameOrSlug, { dir = SIM_DIR, stateFile = SIM_STATE_FILE } = {}) {
    const slug = sanitizeSimulationName(nameOrSlug);
    const fp = simulationFilePath(slug, dir);
    if (!fs.existsSync(fp)) return false;
    try { fs.unlinkSync(fp); } catch { return false; }
    // Clear any scopes pointing at it.
    try {
        const state = loadSimState(stateFile);
        for (const [k, v] of Object.entries(state.scopes || {})) {
            if (v === slug) delete state.scopes[k];
        }
        saveSimState(state, stateFile);
    } catch {}
    return true;
}

export function appendSimulationExchange(nameOrSlug, userText, assistantText, { dir = SIM_DIR } = {}) {
    const sim = loadSimulation(nameOrSlug, dir);
    if (!sim) return null;
    const ts = nowIso();
    if (userText && String(userText).trim()) sim.messages.push({ role: "user", content: String(userText), timestamp: ts });
    if (assistantText && String(assistantText).trim()) sim.messages.push({ role: "assistant", content: String(assistantText), timestamp: ts });
    writeSimulation(sim, dir);
    return sim;
}

export function addSimulationMemory(nameOrSlug, input, { dir = SIM_DIR } = {}) {
    const sim = loadSimulation(nameOrSlug, dir);
    if (!sim) return null;
    const payload = typeof input === "string" ? { content: input } : (input || {});
    const content = String(payload.content || payload.text || "").trim();
    if (!content) throw new Error("Simulation memory content cannot be empty.");
    // Dedup: exact match returns existing.
    const lower = content.toLowerCase();
    const existing = sim.memories.find((m) => String(m.content || "").toLowerCase().trim() === lower);
    if (existing) return existing;
    const mem = {
        id: payload.id || `sim_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`,
        type: payload.type || "fact",
        content,
        confidence: typeof payload.confidence === "number" ? payload.confidence : 0.85,
        importance: typeof payload.importance === "number" ? payload.importance : 0.6,
        tags: Array.isArray(payload.tags) ? payload.tags : ["simulation"],
        source: payload.source || "simulation",
        createdAt: nowIso(),
    };
    if (!mem.tags.includes("simulation")) mem.tags.push("simulation");
    sim.memories.push(mem);
    writeSimulation(sim, dir);
    return mem;
}

/**
 * Lightweight deterministic extraction for simulation turns (kept local to
 * the archive — never touches the global memory DB).
 */
export function extractSimulationHeuristic(nameOrSlug, userText, { dir = SIM_DIR } = {}) {
    const text = String(userText || "").trim();
    if (!text) return { memoriesCreated: 0, details: [] };
    const created = [];
    const push = (type, content, tags) => {
        try {
            const mem = addSimulationMemory(nameOrSlug, { type, content, tags, source: "simulation_heuristic" }, { dir });
            if (mem) created.push(mem);
        } catch {}
    };
    let m;
    if ((m = text.match(/i(?:'m| am) (?:building|working on|developing|creating|maintaining)\s+(.+)/i))) {
        const proj = m[1].replace(/[.?!]+$/, "").trim();
        if (proj.length > 3) push("project", `In simulation: user is building/working on ${proj}.`, ["simulation", "project"]);
    }
    if ((m = text.match(/i (?:prefer|love using|like to use|prefer to use)\s+(.+)/i))) {
        const pref = m[1].replace(/[.?!]+$/, "").trim();
        if (pref.length > 3) push("preference", `In simulation: user prefers ${pref}.`, ["simulation", "preference"]);
    } else if ((m = text.match(/my favorite (.+) is (.+)/i))) {
        push("preference", `In simulation: user's favorite ${m[1].trim()} is ${m[2].replace(/[.?!]+$/, "").trim()}.`, ["simulation", "preference"]);
    }
    if ((m = text.match(/(?:my goal is|i want to achieve|i plan to)\s+(.+)/i))) {
        const goal = m[1].replace(/[.?!]+$/, "").trim();
        if (goal.length > 4) push("goal", `In simulation: user goal: ${goal}.`, ["simulation", "goal"]);
    }
    if ((m = text.match(/(?:actually|no)[,\s]+(?:i changed it|i switched|i meant|that is wrong|it is actually)\.?\s*(.+)/i))) {
        push("correction", `In simulation correction: ${text}`, ["simulation", "correction"]);
    } else if ((m = text.match(/my ([\w-]+) is (.+)/i)) && text.length < 140) {
        push("fact", `In simulation: user's ${m[1].trim()} is ${m[2].replace(/[.?!]+$/, "").trim()}.`, ["simulation", "fact"]);
    }
    return { memoriesCreated: created.length, details: created.map((c) => c.content) };
}

// ---------- retrieval ----------

function scoreDocs(queryTokens, docs) {
    // docs: [{text, boost}]
    const docTokensList = docs.map((d) => Array.from(new Set(simTokenize(d.text))));
    const df = new Map();
    for (const toks of docTokensList) {
        for (const t of toks) df.set(t, (df.get(t) ?? 0) + 1);
    }
    const N = docs.length;
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

/** Ranked memories+chats inside ONE simulation (for active-sim context). */
export function searchSimulation(query, nameOrSlug, { limit = 5, dir = SIM_DIR } = {}) {
    const sim = loadSimulation(nameOrSlug, dir);
    if (!sim) return [];
    const q = String(query || "").trim();
    if (!q) {
        return (sim.memories || []).slice(-limit).map((m) => ({ kind: "memory", text: m.content, memory: m, score: 1 }));
    }
    const queryTokens = simTokenize(q);
    if (queryTokens.length === 0) return [];
    const docs = [
        ...(sim.memories || []).map((m) => ({ kind: "memory", text: `${m.content} ${(m.tags || []).join(" ")}`, memory: m, boost: 1.2 })),
        ...(sim.messages || []).slice(-60).map((msg) => ({ kind: "chat", text: msg.content, message: msg, boost: 1.0 })),
    ];
    if (docs.length === 0) return [];
    return scoreDocs(queryTokens, docs).slice(0, limit);
}

/**
 * Association recall across simulation archives. Returns ONLY matches
 * (overlap > 0) — no fallback — so normal chat stays clean unless the
 * prompt genuinely connects to archived simulation data.
 */
export function searchSimulationArchives(query, { characterId = null, excludeSlug = null, limit = 5, dir = SIM_DIR } = {}) {
    const q = String(query || "").trim();
    if (!q) return [];
    const queryTokens = simTokenize(q);
    if (queryTokens.length === 0) return [];
    const sims = listSimulations({ dir });
    const docs = [];
    for (const meta of sims) {
        if (excludeSlug && meta.slug === excludeSlug) continue;
        // Persona scoping for automatic recall: same owner only.
        if (characterId && meta.characterId && meta.characterId !== characterId) continue;
        const full = loadSimulation(meta.slug, dir);
        if (!full) continue;
        for (const m of full.memories || []) {
            docs.push({
                simulation: full.name, slug: full.slug, characterId: full.characterId || null,
                kind: "memory", text: `${m.content} ${(m.tags || []).join(" ")} ${full.name}`,
                memory: m, boost: 1.2,
            });
        }
        for (const msg of (full.messages || []).slice(-40)) {
            const c = String(msg.content || "").trim();
            if (c.length < 4) continue;
            docs.push({
                simulation: full.name, slug: full.slug, characterId: full.characterId || null,
                kind: "chat", text: `${c} ${full.name}`, message: msg, boost: 0.9,
            });
        }
    }
    if (docs.length === 0) return [];
    return scoreDocs(queryTokens, docs).slice(0, limit);
}

// ---------- prompt framing ----------

export function buildSimulationSystemPrompt(personaName, sim) {
    const scen = (sim.scenario || "").trim();
    const who = personaName || sim.personaName || "the active persona";
    const base = scen
        ? `You are still ${who}, just chatting normally in simulation "${sim.name}". Optional background for this thread: ${scen}. Treat it as loose context, not strict rules — otherwise chat as usual.`
        : `You are still ${who}, just chatting normally in simulation "${sim.name}". This is a separate saved thread, nothing else changes.`;
    return `[SIMULATION "${sim.name}" with ${who} — simple separate chat]\n${base}`;
}

export function formatSimulationArchiveBlock(results) {
    if (!results || results.length === 0) return "";
    const lines = results.map((r) => {
        const text = r.kind === "memory" ? r.memory.content : (r.message?.content || r.text);
        const short = String(text || "").replace(/\s+/g, " ").trim().slice(0, 220);
        return `• [sim:${r.simulation}] (${r.kind}) ${short}`;
    });
    return `[Relevant Simulation Archives — past separate chats; use only when the association genuinely fits]:\n${lines.join("\n")}`;
}

// ---------- command parsing ----------

/**
 * Parse @simulation family commands. Accepts @ or / prefix, case-insensitive.
 * Returns null when the input is NOT a simulation command.
 */
export function parseSimulationCommand(rawInput) {
    const raw = String(rawInput || "").trim();
    if (!raw) return null;
    const norm = raw.startsWith("@") ? "/" + raw.slice(1) : raw;
    const lower = norm.toLowerCase();

    // Explicit end aliases: @simulation-end | @simulation-stop | @simulation-passed | @simulation-pass (+ / variants)
    const endDash = lower.match(/^\/(simulation|sim)[-_](end|stop|passed|pass|close|exit)\b/);
    if (endDash) return { action: "end" };

    if (!lower.startsWith("/simulation") && !lower.startsWith("/sim ") && !lower.startsWith("/sim-") && !lower.startsWith("/sim_")) {
        // @simulations / @sim-list etc without the long prefix
        if (lower === "/simulations" || lower === "/sims" || lower === "/sim-list" || lower === "/simulations-list") return { action: "list" };
        return null;
    }

    // Plural aliases: @simulations / @simulation-list / @simulation-status / @simulation-search ... / @simulation-show ...
    if (lower === "/simulations" || lower === "/sims") return { action: "list" };
    {
        const dashList = lower.match(/^\/(simulation|sim)[-_](list|lists)\b/);
        if (dashList) return { action: "list" };
        const dashStatus = lower.match(/^\/(simulation|sim)[-_](status)\b/);
        if (dashStatus) return { action: "status" };
        const dashSearch = norm.match(/^\/(simulation|sim)[-_](search)\b\s*(.*)$/i);
        if (dashSearch) return { action: "search", query: (dashSearch[3] || "").trim() };
        const dashShow = norm.match(/^\/(simulation|sim)[-_](show)\b\s*(.*)$/i);
        if (dashShow) return { action: "show", name: (dashShow[3] || "").trim() };
        const dashReview = norm.match(/^\/(simulation|sim)[-_](review)\b\s*(.*)$/i);
        if (dashReview) return { action: "review", name: (dashReview[3] || "").trim() };
    }

    // Strip prefix: /simulation | /sim
    const after = norm.replace(/^\/(simulation|sim)\b/i, "").trim();
    if (!after) return { action: "status" };
    const al = after.toLowerCase();

    if (/^(end|stop|passed|pass|close|exit)\b/.test(al)) return { action: "end" };
    if (/^(list|sims|all)\b/.test(al)) return { action: "list" };
    if (/^status\b/.test(al)) return { action: "status" };
    if (/^search\b/.test(al) || al.startsWith("search ")) {
        const query = after.replace(/^search\b/i, "").trim();
        return { action: "search", query };
    }
    if (/^show\b/.test(al)) {
        const name = after.replace(/^show\b/i, "").trim();
        return { action: "show", name };
    }
    if (/^review\b/.test(al)) {
        const name = after.replace(/^review\b/i, "").trim();
        return { action: "review", name };
    }
    if (/^delete\b/.test(al) || /^remove\b/.test(al)) {
        const name = after.replace(/^(delete|remove)\b/i, "").trim();
        return { action: "delete", name };
    }
    // "-search <q>", "-list", "-status", "-show <n>" dash forms
    if (/^[-_]search\b/.test(al)) return { action: "search", query: after.replace(/^[-_]search\b/i, "").trim() };
    if (/^[-_](list|status)\b/.test(al)) return { action: al.includes("list") ? "list" : "status" };
    if (/^[-_]show\b/.test(al)) return { action: "show", name: after.replace(/^[-_]show\b/i, "").trim() };
    if (/^[-_]review\b/.test(al)) return { action: "review", name: after.replace(/^[-_]review\b/i, "").trim() };

    // Otherwise: start. Support "name | scenario" or "name <scenario...>".
    let name = after;
    let scenario = "";
    if (after.includes("|")) {
        const parts = after.split("|");
        name = parts[0].trim();
        scenario = parts.slice(1).join("|").trim();
    } else {
        const sp = after.search(/\s/);
        if (sp !== -1) {
            name = after.slice(0, sp).trim();
            scenario = after.slice(sp + 1).trim();
        }
    }
    if (!name) return { action: "status" };
    return { action: "start", name, scenario };
}

export function formatSimulationList(sims, activeSlug = null) {
    if (!sims || sims.length === 0) return "🎭 No simulations archived yet. Start one with @simulation <name> [| scenario].";
    const lines = [`🎭 Simulations (${sims.length}):`];
    for (const s of sims) {
        const mark = activeSlug && s.slug === activeSlug ? " ▶ ACTIVE" : (s.status === "active" ? " (active elsewhere)" : "");
        lines.push(`  • "${s.name}" [${s.slug}]${mark} — ${s.exchanges} exchange(s), ${s.memories} memori(es)${s.scenario ? ` — ${s.scenario.slice(0, 80)}` : ""}`);
    }
    return lines.join("\n");
}

export function deleteSimulationMemory(nameOrSlug, identifier, { dir = SIM_DIR } = {}) {
    const sim = loadSimulation(nameOrSlug, dir);
    if (!sim) return { success: false, message: "Simulation not found." };
    const list = sim.memories || [];
    let idx = -1;
    const num = parseInt(identifier, 10);
    if (!isNaN(num) && num >= 1 && num <= list.length) idx = num - 1;
    else idx = list.findIndex((m) => m.id === identifier);
    if (idx < 0) return { success: false, message: `Simulation memory '${identifier}' not found.` };
    const [removed] = list.splice(idx, 1);
    writeSimulation(sim, dir);
    return { success: true, removed };
}

export function updateSimulationMemory(nameOrSlug, identifier, newText, { dir = SIM_DIR } = {}) {
    const sim = loadSimulation(nameOrSlug, dir);
    if (!sim) return { success: false, message: "Simulation not found." };
    const list = sim.memories || [];
    let idx = -1;
    const num = parseInt(identifier, 10);
    if (!isNaN(num) && num >= 1 && num <= list.length) idx = num - 1;
    else idx = list.findIndex((m) => m.id === identifier);
    if (idx < 0) return { success: false, message: `Simulation memory '${identifier}' not found.` };
    list[idx].content = String(newText || "").trim();
    writeSimulation(sim, dir);
    return { success: true, memory: list[idx] };
}

export function formatSimulationMemories(nameOrSlug, query = "", limit = 50, { dir = SIM_DIR } = {}) {
    const sim = loadSimulation(nameOrSlug, dir);
    if (!sim) return "🎭 Simulation not found.";
    if (query && query.trim()) {
        const hits = searchSimulation(query, sim.slug, { limit, dir });
        if (hits.length === 0) return `🎭 No simulation memories in "${sim.name}" matching "${query}".`;
        const lines = [`🎭 Simulation "${sim.name}" matches for "${query}" (${hits.length}):`];
        hits.forEach((h, i) => {
            const text = h.kind === "memory" ? h.memory.content : (h.message?.content || "");
            lines.push(`  ${i + 1}. (${h.kind}) ${text}`);
        });
        return lines.join("\n");
    }
    const mems = sim.memories || [];
    if (mems.length === 0) return `🎭 Simulation "${sim.name}" has no stored memories yet (exchanges: ${Math.floor((sim.messages || []).length / 2)}).`;
    const lines = [`🎭 Simulation "${sim.name}" memories (${mems.length}):`];
    mems.slice(-limit).forEach((m, i) => lines.push(`  ${i + 1}. [${m.id}] (${m.type}) ${m.content}`));
    return lines.join("\n");
}

/**
 * Full review of ALL conversational data in a saved simulation archive.
 * Deterministic: header + stats + topics + memories + complete turn transcript.
 */
export function formatSimulationReview(nameOrSlug, { dir = SIM_DIR, maxCharsPerTurn = 2000 } = {}) {
    const sim = loadSimulation(nameOrSlug, dir);
    if (!sim) return "🎭 Simulation not found.";
    const msgs = Array.isArray(sim.messages) ? sim.messages : [];
    const mems = Array.isArray(sim.memories) ? sim.memories : [];
    const users = msgs.filter((m) => m.role === "user");
    const assistants = msgs.filter((m) => m.role === "assistant");
    const totalChars = msgs.reduce((n, m) => n + String(m.content || "").length, 0);
    const avgUser = users.length ? Math.round(users.reduce((n, m) => n + String(m.content || "").length, 0) / users.length) : 0;
    const avgAsst = assistants.length ? Math.round(assistants.reduce((n, m) => n + String(m.content || "").length, 0) / assistants.length) : 0;
    const stamps = msgs.map((m) => String(m.timestamp || "")).filter(Boolean).sort();
    const span = stamps.length ? `${stamps[0]} → ${stamps[stamps.length - 1]}` : "n/a";
    // Top topic tokens across the whole conversation.
    const freq = new Map();
    for (const m of msgs) {
        for (const t of simTokenize(String(m.content || ""))) freq.set(t, (freq.get(t) ?? 0) + 1);
    }
    const topics = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([t, c]) => `${t}×${c}`).join(", ") || "n/a";

    const lines = [
        `🎭 Review: "${sim.name}" [${sim.slug}] (${sim.status || "archived"}) — persona "${sim.personaName || sim.characterId || "?"}":`,
        `Scenario: ${sim.scenario || "(none)"}`,
        `Created: ${sim.createdAt || "n/a"} | Ended: ${sim.endedAt || "n/a"} | Updated: ${sim.updatedAt || "n/a"}`,
        `Archive: data/simulations/${sim.slug}.json`,
        `Stats: ${msgs.length} message(s) (${users.length} user, ${assistants.length} assistant, ${Math.floor(msgs.length / 2)} exchange(s)) | ${mems.length} memori(es) | ${totalChars} chars (avg user ${avgUser}, avg assistant ${avgAsst})`,
        `Span: ${span}`,
        `Topics: ${topics}`,
    ];
    if (mems.length === 0) {
        lines.push(`Memories: (none)`);
    } else {
        lines.push(`Memories (${mems.length}):`);
        mems.forEach((m, i) => lines.push(`  ${i + 1}. [${m.type || "fact"}] ${String(m.content || "").replace(/\s+/g, " ").trim().slice(0, 220)}`));
    }
    if (msgs.length === 0) {
        lines.push(`Conversation: (no turns saved)`);
    } else {
        lines.push(`Conversation — all ${msgs.length} turn(s):`);
        msgs.forEach((m, i) => {
            const body = String(m.content || "").replace(/\s+/g, " ").trim();
            const excerpt = body.length > maxCharsPerTurn ? `${body.slice(0, maxCharsPerTurn)}… [truncated ${body.length - maxCharsPerTurn} chars]` : body;
            lines.push(`  ${i + 1}. [${m.role}]${m.timestamp ? ` (${m.timestamp})` : ""}: ${excerpt}`);
        });
    }
    return lines.join("\n");
}

/**
 * Shared bridge helper: handle @simulation family commands for
 * Telegram / WhatsApp / Web surfaces. Returns { handled, reply }.
 */
export function handleSimulationBridgeCommand(rawInput, { platform = "cli", characterId = "main", personaName = "", chatId = "default", dir = SIM_DIR, stateFile = SIM_STATE_FILE } = {}) {
    const parsed = parseSimulationCommand(rawInput);
    if (!parsed) return { handled: false, reply: null };
    const scope = scopeKeyFor(platform, characterId, chatId);
    if (parsed.action === "start") {
        const existing = getActiveSimulation(scope, { dir, stateFile });
        if (existing && existing.slug !== sanitizeSimulationName(parsed.name)) {
            return { handled: true, reply: `⚠️ Simulation "${existing.name}" is already active. End it first with @simulation-end, then start "${parsed.name}".` };
        }
        try {
            const sim = startSimulation({ name: parsed.name, scenario: parsed.scenario || "", characterId, personaName, scopeKey: scope, dir, stateFile });
            return { handled: true, reply: `🎭 Simulation "${sim.name}" started inside persona "${personaName || characterId}".\n${buildSimulationSystemPrompt(personaName || characterId, sim)}\n💾 Archive: data/simulations/${sim.slug}.json` };
        } catch (err) {
            return { handled: true, reply: `⚠️ Simulation start error: ${err.message || err}` };
        }
    }
    if (parsed.action === "end") {
        const sim = endSimulation(scope, { dir, stateFile });
        if (!sim) return { handled: true, reply: "⚠️ No active simulation to end for this chat." };
        const exchanges = Math.floor((sim.messages || []).length / 2);
        return { handled: true, reply: `🎭 Simulation "${sim.name}" ended & archived (${exchanges} exchange(s), ${(sim.memories || []).length} memori(es)).` };
    }
    if (parsed.action === "status") {
        const sim = getActiveSimulation(scope, { dir, stateFile });
        if (!sim) return { handled: true, reply: `🎭 No active simulation.\n${formatSimulationList(listSimulations({ dir }))}\n💡 Start with @simulation <name>.` };
        return { handled: true, reply: `🎭 ACTIVE simulation "${sim.name}" [${sim.slug}] — ${Math.floor((sim.messages || []).length / 2)} exchange(s), ${(sim.memories || []).length} memori(es).${sim.scenario ? `\nNote: ${sim.scenario}` : ""}` };
    }
    if (parsed.action === "list") {
        const active = getActiveSimulation(scope, { dir, stateFile });
        return { handled: true, reply: formatSimulationList(listSimulations({ dir }), active?.slug) };
    }
    if (parsed.action === "search") {
        const q = (parsed.query || "").trim();
        if (!q) return { handled: true, reply: "⚠️ Usage: @simulation-search <query>" };
        const hits = searchSimulationArchives(q, { limit: 8, dir });
        if (hits.length === 0) return { handled: true, reply: `🎭 No simulation archive matches for "${q}".` };
        return { handled: true, reply: formatSimulationArchiveBlock(hits) };
    }
    if (parsed.action === "show") {
        const sim = parsed.name ? loadSimulation(parsed.name, dir) : getActiveSimulation(scope, { dir, stateFile });
        if (!sim) return { handled: true, reply: `⚠️ Simulation "${parsed.name || ""}" not found.` };
        return { handled: true, reply: `🎭 Simulation "${sim.name}" [${sim.slug}] (${sim.status}):\nExchanges: ${Math.floor((sim.messages || []).length / 2)} | Memories: ${(sim.memories || []).length}${sim.scenario ? `\nNote: ${sim.scenario}` : ""}` };
    }
    if (parsed.action === "review") {
        const target = (parsed.name || "").trim();
        const sim = target ? loadSimulation(target, dir) : getActiveSimulation(scope, { dir, stateFile });
        if (!sim) return { handled: true, reply: `⚠️ Simulation "${target}" not found.${target ? "" : " Start one with @simulation <name> or pass a name: @simulation-review <name>."}` };
        return { handled: true, reply: formatSimulationReview(sim.slug, { dir }) };
    }
    if (parsed.action === "delete") {
        if (!parsed.name) return { handled: true, reply: "⚠️ Usage: @simulation delete <name>" };
        const ok = deleteSimulation(parsed.name, { dir, stateFile });
        return { handled: true, reply: ok ? `🗑 Simulation "${parsed.name}" archive deleted.` : `⚠️ Simulation "${parsed.name}" not found.` };
    }
    return { handled: false, reply: null };
}

/**
 * Shared augmentation for chat pipelines: returns the active simulation
 * (if any) plus ready-to-inject system blocks and isolated history.
 */
export function getSimulationChatAugmentation(query, { platform = "cli", characterId = "main", chatId = "default", personaName = "", limit = 5, dir = SIM_DIR, stateFile = SIM_STATE_FILE } = {}) {
    const scope = scopeKeyFor(platform, characterId, chatId);
    const activeSim = getActiveSimulation(scope, { dir, stateFile });
    const blocks = [];
    let historyOverride = null;
    if (activeSim) {
        blocks.push(buildSimulationSystemPrompt(personaName || characterId, activeSim));
        try {
            const local = searchSimulation(query, activeSim.slug, { limit, dir });
            const localTexts = local.filter((h) => h.kind === "memory").map((h) => h.memory.content);
            if (localTexts.length > 0) {
                blocks.push(`[Simulation "${activeSim.name}" Memories]:\n${localTexts.map((m) => `• ${m}`).join("\n")}`);
            }
        } catch {}
        historyOverride = (activeSim.messages || [])
            .filter((m) => m.role === "user" || m.role === "assistant")
            .map((m) => ({ role: m.role, content: m.content }));
    }
    // Cross-archive recall (excludes the active sim to avoid duplication).
    try {
        const archives = searchSimulationArchives(query, { characterId, excludeSlug: activeSim?.slug || null, limit: 3, dir });
        if (archives.length > 0) blocks.push(formatSimulationArchiveBlock(archives));
    } catch {}
    return { activeSim, scope, blocks, historyOverride };
}
