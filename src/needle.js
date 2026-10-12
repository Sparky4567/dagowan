// ---------------------------------------------------------------------------
// On-device tool calling + structured extraction via cactus-needle
// (https://github.com/cactus-compute/needle).
//
// Needle is a 8-29 MB automation foundation model: grammar-constrained tool
// calls, typed extraction, and local embeddings. The Python package
// (`cactus-needle`) has no JS SDK, so this module shells out to
// `src/needle_bridge.py` (stdin JSON in, stdout JSON out).
//
// Design notes (match repo conventions in play_api.js / blog_api.js):
//   - Pure parsers/formatters are dependency-free and unit-tested.
//   - The only side effect (spawning python) goes through an injectable
//     `spawnFn`, so `bun test` never downloads weights or hits network.
//   - Empty `function_calls` is Needle's refusal for off-topic input —
//     always handle it, never invent arguments (optional fields may be
//     absent when the input gives no evidence).
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { remember } from "./memory.js";
import { registerTask } from "./tasks.js";
import { getActiveCharacter } from "./characters.js";
import { saveSettings } from "./config.js";
import { memoize } from "./utils/memoize.js";

export const NEEDLE_PACKAGE = "cactus-needle";
export const NEEDLE_INSTALL_HINT = "pip install cactus-needle  (first @needle run downloads the ~35 MB needle3.cact weights once, then runs offline)";
export const NEEDLE_DEFAULT_MIN_CONFIDENCE = 0.7;
export const NEEDLE_BRIDGE_SCRIPT = path.join("src", "needle_bridge.py");

// Small default tool catalog (<=5 tools so Needle's retrieval head renders
// all of them every turn). Each maps to an existing local assistant action.
export const NEEDLE_DEFAULT_TOOLS = [
    {
        name: "remember_memory",
        description: "Save a durable fact, preference, or correction to persistent memory. Use for 'remember that...', 'I prefer...', 'my favorite ... is...' statements.",
        parameters: {
            type: "object",
            properties: { text: { type: "string", description: "The fact to remember verbatim" } },
            required: ["text"],
        },
    },
    {
        name: "register_task",
        description: "Add a task or to-do item to the Kanban task board. Use for 'add a task', 'remind me to...', 'todo' requests.",
        parameters: {
            type: "object",
            properties: { description: { type: "string", description: "Task description" } },
            required: ["description"],
        },
    },
    {
        name: "save_note",
        description: "Save a Markdown note document with a title and body. Only use when the user explicitly asks to write, jot down, or save a note document (never for tasks or reminders).",
        parameters: {
            type: "object",
            properties: {
                title: { type: "string", description: "Note title (used as filename)" },
                content: { type: "string", description: "Note body in Markdown" },
            },
            required: ["title", "content"],
        },
    },
    {
        name: "set_proactive_timer",
        description: "Set the proactive chat idle check-in timer.",
        parameters: {
            type: "object",
            properties: { minutes: { type: "integer", minimum: 1, maximum: 1440 } },
            required: ["minutes"],
        },
    },
];

// --- settings ---------------------------------------------------------------

export function getNeedlePython(settings = {}) {
    return (
        (settings && settings.needle_python) ||
        process.env.NEEDLE_PYTHON ||
        "python3"
    );
}

export function getNeedleWeights(settings = {}) {
    return (
        (settings && settings.needle_model_path) ||
        process.env.NEEDLE_MODEL_PATH ||
        ""
    );
}

export function getNeedleMinConfidence(settings = {}) {
    const raw =
        (settings && settings.needle_min_confidence) ??
        process.env.NEEDLE_MIN_CONFIDENCE ??
        NEEDLE_DEFAULT_MIN_CONFIDENCE;
    const n = Number(raw);
    if (!Number.isFinite(n)) return NEEDLE_DEFAULT_MIN_CONFIDENCE;
    if (n < 0) return 0;
    if (n > 1) return 1;
    return n;
}

export function isNeedleAutoRoutingEnabled(settings = {}) {
    const v = (settings && settings.needle_enabled) ?? process.env.NEEDLE_ENABLED ?? false;
    if (typeof v === "boolean") return v;
    return ["1", "true", "on", "yes", "enable", "enabled"].includes(String(v).trim().toLowerCase());
}

export function getNeedleStatus(settings = {}) {
    return {
        autoRouting: isNeedleAutoRoutingEnabled(settings),
        python: getNeedlePython(settings),
        modelPath: getNeedleWeights(settings) || "(built-in needle3.cact)",
        minConfidence: getNeedleMinConfidence(settings),
        bridge: NEEDLE_BRIDGE_SCRIPT,
    };
}

// --- command parsing --------------------------------------------------------
//
// Shared "@needle ..." parser so CLI / Telegram / WhatsApp behave identically.
// Returns null when `text` is not a needle command.

export function parseNeedleInput(text, settings = {}) {
    const rawInput = String(text || "").trim();
    const norm = rawInput.startsWith("@") ? "/" + rawInput.slice(1) : rawInput;
    const low = norm.toLowerCase();
    const head = low.split(/\s/, 1)[0];

    if (head === "/needle-status" || head === "/needle_info" || head === "/needle-info") {
        return { action: "status" };
    }
    if (head === "/needle-tools" || head === "/needle_list" || head === "/needle-list") {
        return { action: "tools" };
    }
    if (head === "/needle-embed" || head === "/needle_embed") {
        return { action: "embed", text: norm.slice(head.length).trim() };
    }
    if (head === "/needle-extract" || head === "/needle_extract") {
        const payload = norm.slice(head.length).trim();
        if (!payload) return { action: "extract", schema: null, text: "" };
        const split = splitSchemaAndText(payload);
        return { action: "extract", ...split };
    }
    if (head === "/needle" || head === "/needle-run" || head === "/needle_run") {
        return { action: "route", text: norm.slice(head.length).trim() };
    }
    return null;
}

// Split "@needle-extract <JSON schema> <text>" into {schema, text}.
// Finds the first balanced {...} block; everything after it is the text.
export function splitSchemaAndText(payload) {
    const s = String(payload || "");
    const start = s.indexOf("{");
    if (start === -1) return { schema: null, text: s.trim() };
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < s.length; i++) {
        const ch = s[i];
        if (inStr) {
            if (esc) esc = false;
            else if (ch === "\\") esc = true;
            else if (ch === '"') inStr = false;
            continue;
        }
        if (ch === '"') inStr = true;
        else if (ch === "{") depth++;
        else if (ch === "}") {
            depth--;
            if (depth === 0) {
                const jsonPart = s.slice(start, i + 1);
                try {
                    return { schema: JSON.parse(jsonPart), text: s.slice(i + 1).trim() };
                } catch {
                    return { schema: null, text: s.trim() };
                }
            }
        }
    }
    return { schema: null, text: s.trim() };
}

// --- bridge -----------------------------------------------------------------

function resolveBridgeScript(cwd = process.cwd()) {
    const abs = path.isAbsolute(NEEDLE_BRIDGE_SCRIPT)
        ? NEEDLE_BRIDGE_SCRIPT
        : path.join(cwd, NEEDLE_BRIDGE_SCRIPT);
    return abs;
}

function defaultSpawnFn(pythonBin, scriptPath, payloadJson, timeoutMs = 120000) {
    return new Promise((resolve) => {
        let child;
        try {
            child = spawn(pythonBin, [scriptPath], { stdio: ["pipe", "pipe", "pipe"] });
        } catch (err) {
            resolve({ success: false, error: `Failed to launch ${pythonBin}: ${err.message || err}` });
            return;
        }
        let out = "";
        let errOut = "";
        const timer = setTimeout(() => {
            try { child.kill("SIGKILL"); } catch {}
            resolve({ success: false, error: `needle bridge timed out after ${timeoutMs}ms` });
        }, timeoutMs);
        if (timer.unref) timer.unref();
        child.on("error", (err) => {
            clearTimeout(timer);
            resolve({ success: false, error: `Failed to launch ${pythonBin}: ${err.message || err}` });
        });
        child.stdout.on("data", (d) => { out += String(d); });
        child.stderr.on("data", (d) => { errOut += String(d); });
        child.on("close", (code) => {
            clearTimeout(timer);
            if (!out.trim()) {
                resolve({ success: false, error: errOut.trim() || `needle bridge exited with code ${code}` });
                return;
            }
            try {
                resolve(JSON.parse(out));
            } catch (err) {
                resolve({ success: false, error: `Invalid needle bridge output: ${err.message}` });
            }
        });
        try {
            child.stdin.write(payloadJson);
            child.stdin.end();
        } catch (err) {
            clearTimeout(timer);
            resolve({ success: false, error: `needle bridge write failed: ${err.message || err}` });
        }
    });
}

export async function runNeedleBridge(payload, settings = {}, spawnFn = null) {
    const script = resolveBridgeScript();
    if (!fs.existsSync(script)) {
        return { success: false, error: `needle bridge script missing: ${NEEDLE_BRIDGE_SCRIPT}` };
    }
    const run = spawnFn || defaultSpawnFn;
    try {
        return await run(getNeedlePython(settings), script, JSON.stringify(payload || {}));
    } catch (err) {
        return { success: false, error: `needle bridge error: ${err.message || err}` };
    }
}

export async function needleComplete(userText, settings = {}, opts = {}, spawnFn = null) {
    const payload = {
        mode: "complete",
        text: String(userText || ""),
        tools: opts.tools || NEEDLE_DEFAULT_TOOLS,
        system: opts.system || settings.needle_system || process.env.NEEDLE_SYSTEM || undefined,
        weights: opts.weights || getNeedleWeights(settings) || undefined,
        max_new_tokens: opts.maxTokens || 512,
    };
    return runNeedleBridge(payload, settings, spawnFn);
}

export async function needleExtract(userText, schema, settings = {}, opts = {}, spawnFn = null) {
    const payload = {
        mode: "extract",
        text: String(userText || ""),
        schema: schema || {},
        system: opts.system || undefined,
        weights: opts.weights || getNeedleWeights(settings) || undefined,
        max_new_tokens: opts.maxTokens || 512,
        strict: opts.strict !== false,
    };
    return runNeedleBridge(payload, settings, spawnFn);
}

export async function needleEmbed(userText, settings = {}, opts = {}, spawnFn = null) {
    const payload = {
        mode: "embed",
        text: String(userText || ""),
        weights: opts.weights || getNeedleWeights(settings) || undefined,
    };
    return runNeedleBridge(payload, settings, spawnFn);
}

// --- formatting (confidence gating per Needle guide) -------------------------

export function formatNeedleRouteResult(res, settings = {}) {
    if (!res || !res.success) {
        const err = (res && res.error) || "unknown error";
        if (/not installed|No module named|Failed to launch/i.test(String(err))) {
            return `⚠️ Needle is not installed. ${NEEDLE_INSTALL_HINT}`;
        }
        return `⚠️ Needle error: ${err}`;
    }
    const calls = Array.isArray(res.function_calls) ? res.function_calls : [];
    const held = res.suppressed_calls || null;
    const conf = typeof res.confidence === "number" ? res.confidence : null;
    const threshold = getNeedleMinConfidence(settings);
    if (calls.length === 0 && !held) {
        return "🪡 Needle: no local tool covers that request (empty call list = refusal). Try the main LLM or rephrase with a supported action (remember / task / note / timer).";
    }
    const lines = ["🪡 Needle on-device routing:"];
    const show = calls.length > 0 ? calls : (held ? [held] : []);
    for (const c of show) {
        lines.push(`  • ${c.name}(${JSON.stringify(c.arguments || {})})`);
    }
    if (conf !== null) lines.push(`Confidence: ${conf.toFixed(2)} (act ≥ ${threshold.toFixed(2)}, else confirm)`);
    if (res.reasoning) lines.push(`Reasoning: ${res.reasoning}`);
    if (calls.length === 0 && held) lines.push("Note: call was withheld below the confidence floor — confirm before acting.");
    else if (conf !== null && conf < threshold) lines.push("Note: below the act threshold — confirm before acting.");
    return lines.join("\n");
}

export function formatNeedleExtractResult(res) {
    if (!res || !res.success) {
        const err = (res && res.error) || "unknown error";
        if (/not installed|No module named|Failed to launch/i.test(String(err))) {
            return `⚠️ Needle is not installed. ${NEEDLE_INSTALL_HINT}`;
        }
        return `⚠️ Needle extract error: ${err}`;
    }
    if (res.refused || res.result === null || res.result === undefined) {
        return "🪡 Needle: nothing matched the schema (refusal — no fields invented).";
    }
    return `🪡 Needle extraction:\n${JSON.stringify(res.result, null, 2)}`;
}

export function formatNeedleStatus(res, settings = {}) {
    const st = getNeedleStatus(settings);
    const lines = [
        "🪡 Needle on-device engine (cactus-compute/needle):",
        `  • Auto-routing: ${st.autoRouting ? "enabled" : "disabled"} (@set-setting needle_enabled <on|off>)`,
        `  • Python: ${st.python}`,
        `  • Package: ${res && res.installed ? `installed (v${res.version || "?"})` : "missing — " + NEEDLE_INSTALL_HINT}`,
        `  • Model: ${st.modelPath}`,
        `  • Act threshold: ${st.minConfidence} (@set-setting needle_min_confidence <0-1>)`,
    ];
    return lines.join("\n");
}

export function formatNeedleStatus(res, settings = {}) {
    const st = getNeedleStatus(settings);
    const lines = [
        "🪡 Needle on-device engine (cactus-compute/needle):",
        `  • Auto-routing: ${st.autoRouting ? "enabled (fast-path on CLI/Telegram/WhatsApp/voice)" : "disabled"} (@set-setting needle_enabled <on|off>)`,
        `  • Python: ${st.python}`,
        `  • Package: ${res && res.installed ? `installed (v${res.version || "?"})` : "missing — " + NEEDLE_INSTALL_HINT}`,
        `  • Model: ${st.modelPath}`,
        `  • Act threshold: ${st.minConfidence} (@set-setting needle_min_confidence <0-1>)`,
        `  • Daemon: ${sharedDaemon && sharedDaemon.status().running ? "running" : "stopped (lazy-starts on first fast-path turn, idles out)"}`,
    ];
    return lines.join("\n");
}

// --- shared local-tool executor --------------------------------------------
// Runs one Needle-proposed call through the existing assistant actions.
// Only invoked at/above the act threshold; low-confidence proposals are
// shown for confirmation and never reach this function.

export async function executeNeedleCall(call, context) {
    const name = call && call.name;
    const args = (call && call.arguments) || {};
    try {
        if (name === "remember_memory") {
            const text = String(args.text || "").trim();
            if (!text) return "⚠️ remember_memory skipped: empty text.";
            let activeCharId = (context && context.activeCharacterId) || null;
            if (!activeCharId) {
                try { activeCharId = getActiveCharacter(context.characterStore).id; } catch { activeCharId = context?.settings?.active_character || null; }
            }
            const mem = remember(text, undefined, activeCharId);
            return `🧠 Remembered [${mem.id}]: "${text}"`;
        }
        if (name === "register_task") {
            const description = String(args.description || "").trim();
            if (!description) return "⚠️ register_task skipped: empty description.";
            const task = registerTask(description, "p");
            return `📋 Task #${task.id} registered: "${description}"`;
        }
        if (name === "save_note") {
            const title = String(args.title || "needle-note").trim() || "needle-note";
            const content = String(args.content || "").trim();
            if (!content) return "⚠️ save_note skipped: empty content.";
            const safe = title.toLowerCase().replace(/[^a-z0-9-_]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "needle-note";
            const notesDir = path.resolve(process.cwd(), "notes");
            if (!fs.existsSync(notesDir)) fs.mkdirSync(notesDir, { recursive: true });
            const outPath = path.join(notesDir, `${safe}.md`);
            fs.writeFileSync(outPath, `# ${title}\n\n${content}\n`, "utf8");
            return `📝 Note saved: ${outPath}`;
        }
        if (name === "set_proactive_timer") {
            const minutes = Number(args.minutes);
            if (!Number.isFinite(minutes) || minutes <= 0) return "⚠️ set_proactive_timer skipped: minutes must be > 0.";
            if (context && context.settings) {
                context.settings.proactive_idle_seconds = Math.round(minutes * 60);
                context.settings.proactive_chat_enabled = true;
                saveSettings(context.settings);
            }
            try {
                if (context && context.proactiveManager && typeof context.proactiveManager.startTimer === "function") {
                    context.proactiveManager.startTimer();
                }
            } catch {}
            return `⏱ Proactive check-in timer set to ${minutes} minute(s).`;
        }
        return `⚠️ Unknown Needle tool "${name}" — nothing executed.`;
    } catch (err) {
        return `⚠️ ${name} failed: ${err.message || err}`;
    }
}

// --- fast-path gating -------------------------------------------------------
// Cheap pre-filter (microseconds) before paying for a daemon roundtrip.
// Deliberately BROAD (high recall): Needle's grammar + confidence gate
// supplies the precision. Skips @commands, tiny chitchat, and long pastes.

export const NEEDLE_FAST_PATH_MIN_CHARS = 6;
export const NEEDLE_FAST_PATH_MAX_CHARS = 500;

const NEEDLE_HINT_RE =
    /\b(remind|remember|don't forget|dont forget|task|todo|to-do|note|notes|save|writing down|write down|timer|alarm|check in|prefer|favourite|favorite|i like|i love|i hate|i dislike|my goal|i'm building|i am building|i am working|working on|project|idea|shopping|buy|groceries|call|email|schedule|meeting|appointment|birthday|anniversary|deadline|habit|medicat|medication|pill|workout|exercise)\b/i;
const NEEDLE_IMPERATIVE_RE =
    /^(add|create|save|set|remind|remember|note|make|schedule|register|store)\b/i;

function isNeedleFastPathCandidateUncached(text) {
    const s = String(text || "").trim();
    if (!s || s.startsWith("@") || s.startsWith("/")) return false;
    if (s.length < NEEDLE_FAST_PATH_MIN_CHARS || s.length > NEEDLE_FAST_PATH_MAX_CHARS) return false;
    if (s.includes("```")) return false;
    return NEEDLE_HINT_RE.test(s) || NEEDLE_IMPERATIVE_RE.test(s);
}

// Background-learning triage: turns this short carry no durable content for
// the LLM extraction pass (the synchronous heuristic pass already ran).
// Saves one LLM call per chitchat turn with no extraction loss.

function isTrivialTurnUncached(text) {
    const s = String(text || "").trim().toLowerCase();
    if (!s) return true;
    const words = s.split(/\s+/).filter(Boolean);
    return words.length < 3;
}

// Per-turn regex gates run on every chat message — memoize the pure checks.
export const isNeedleFastPathCandidate = memoize(isNeedleFastPathCandidateUncached, { maxSize: 1000 });
export const isTrivialTurn = memoize(isTrivialTurnUncached, { maxSize: 1000 });

// --- persistent daemon client -----------------------------------------------
// One-shot spawns pay ~10 s process+model startup per call; the daemon loads
// once and serves warm turns at decode cost (~3-5 s on CPU). Lifecycle:
// lazy-start on first use, idle auto-shutdown (frees ~150 MB), restart on
// crash. All I/O goes through the injectable `spawnDaemon` factory so tests
// never touch python.

export const NEEDLE_DAEMON_SCRIPT = path.join("src", "needle_daemon.py");
export const NEEDLE_DAEMON_DEFAULT_IDLE_MS = 300000;
export const NEEDLE_DAEMON_INIT_TIMEOUT_MS = 240000;
export const NEEDLE_DAEMON_REQUEST_TIMEOUT_MS = 90000;

export function getNeedleDaemonIdleMs(settings = {}) {
    const raw = (settings && settings.needle_daemon_idle_ms) ?? process.env.NEEDLE_DAEMON_IDLE_MS ?? NEEDLE_DAEMON_DEFAULT_IDLE_MS;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return NEEDLE_DAEMON_DEFAULT_IDLE_MS;
    return n;
}

function defaultSpawnDaemon(pythonBin, scriptPath) {
    return spawn(pythonBin, [scriptPath], { stdio: ["pipe", "pipe", "pipe"] });
}

export function createDaemonClient({ spawnDaemon = null, idleMs = NEEDLE_DAEMON_DEFAULT_IDLE_MS } = {}) {
    const spawnFn = spawnDaemon || defaultSpawnDaemon;
    let child = null;
    let nextId = 1;
    let hasServed = false;
    const pending = new Map();
    let buffer = "";
    let idleTimer = null;

    function clearIdle() {
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    }

    function armIdle() {
        clearIdle();
        if (idleMs > 0 && pending.size === 0) {
            idleTimer = setTimeout(() => { stop(); }, idleMs);
            if (idleTimer.unref) idleTimer.unref();
        }
    }

    function onCloseOrError(err) {
        const queued = [...pending.values()];
        pending.clear();
        clearIdle();
        child = null;
        for (const { reject } of queued) {
            reject(new Error(err || "needle daemon exited"));
        }
    }

    function ensure(pythonBin, scriptPath) {
        if (child) return child;
        buffer = "";
        const proc = spawnFn(pythonBin, scriptPath);
        child = proc;
        try {
            proc.stdout.on("data", (d) => {
                buffer += String(d);
                let idx;
                while ((idx = buffer.indexOf("\n")) !== -1) {
                    const line = buffer.slice(0, idx).trim();
                    buffer = buffer.slice(idx + 1);
                    if (!line) continue;
                    let msg;
                    try { msg = JSON.parse(line); } catch { continue; }
                    const entry = pending.get(msg.id);
                    if (entry) {
                        pending.delete(msg.id);
                        entry.resolve(msg);
                        if (pending.size === 0) armIdle();
                    }
                }
            });
            proc.stderr.on("data", () => {});
            proc.on("error", (e) => onCloseOrError(e.message || String(e)));
            proc.on("close", () => onCloseOrError(null));
        } catch (e) {
            onCloseOrError(e.message || String(e));
            throw e;
        }
        armIdle();
        return proc;
    }

    async function request(pythonBin, scriptPath, payload, { timeoutMs = NEEDLE_DAEMON_REQUEST_TIMEOUT_MS, firstTimeoutMs = NEEDLE_DAEMON_INIT_TIMEOUT_MS } = {}) {
        const cold = !hasServed;
        const proc = ensure(pythonBin, scriptPath);
        const id = nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                pending.delete(id);
                reject(new Error(`needle daemon timed out after ${cold ? firstTimeoutMs : timeoutMs}ms`));
            }, cold ? firstTimeoutMs : timeoutMs);
            if (timer.unref) timer.unref();
            pending.set(id, { resolve: (m) => { clearTimeout(timer); hasServed = true; resolve(m); }, reject: (e) => { clearTimeout(timer); reject(e); } });
            clearIdle();
            try {
                proc.stdin.write(JSON.stringify({ ...payload, id }) + "\n");
            } catch (e) {
                pending.delete(id);
                clearTimeout(timer);
                reject(e);
            }
        });
    }

    function stop() {
        clearIdle();
        const queued = [...pending.values()];
        pending.clear();
        const proc = child;
        child = null;
        for (const { reject } of queued) reject(new Error("needle daemon stopped"));
        try { if (proc) proc.kill("SIGKILL"); } catch {}
    }

    return {
        request,
        stop,
        status: () => ({ running: Boolean(child), pending: pending.size }),
    };
}

// Module singleton: one daemon per process (vergil: CLI + bridges share it).
let sharedDaemon = null;

export function getNeedleDaemon(settings = {}, spawnDaemon = null) {
    if (!sharedDaemon) {
        sharedDaemon = createDaemonClient({
            spawnDaemon,
            idleMs: getNeedleDaemonIdleMs(settings),
        });
    }
    return sharedDaemon;
}

export function stopNeedleDaemon() {
    try { if (sharedDaemon) sharedDaemon.stop(); } catch {}
    sharedDaemon = null;
}

function resolveDaemonScript(cwd = process.cwd()) {
    return path.isAbsolute(NEEDLE_DAEMON_SCRIPT)
        ? NEEDLE_DAEMON_SCRIPT
        : path.join(cwd, NEEDLE_DAEMON_SCRIPT);
}

// Daemon-aware routing: uses the warm daemon when auto-routing is enabled,
// otherwise the dependency-free one-shot bridge (explicit @needle use with
// the flag off must not start a resident process).

export async function routeWithNeedle(text, settings = {}, opts = {}, deps = {}) {
    const payload = {
        mode: "complete",
        text: String(text || ""),
        tools: opts.tools || NEEDLE_DEFAULT_TOOLS,
        system: opts.system || settings.needle_system || process.env.NEEDLE_SYSTEM || undefined,
        weights: opts.weights || getNeedleWeights(settings) || undefined,
        max_new_tokens: opts.maxTokens || 128,
    };
    if (!isNeedleAutoRoutingEnabled(settings)) {
        return runNeedleBridge(payload, settings, deps.spawnFn || null);
    }
    const script = resolveDaemonScript();
    if (!fs.existsSync(script)) {
        return { success: false, error: `needle daemon script missing: ${NEEDLE_DAEMON_SCRIPT}` };
    }
    try {
        const daemon = deps.daemon || getNeedleDaemon(settings, deps.spawnDaemon || null);
        return await daemon.request(getNeedlePython(settings), script, payload);
    } catch (err) {
        return { success: false, error: `needle daemon error: ${err.message || err}` };
    }
}

export async function extractWithNeedle(text, schema, settings = {}, opts = {}, deps = {}) {
    const payload = {
        mode: "extract",
        text: String(text || ""),
        schema: schema || {},
        weights: opts.weights || getNeedleWeights(settings) || undefined,
        max_new_tokens: opts.maxTokens || 256,
    };
    if (!isNeedleAutoRoutingEnabled(settings)) {
        return runNeedleBridge(payload, settings, deps.spawnFn || null);
    }
    try {
        const daemon = deps.daemon || getNeedleDaemon(settings, deps.spawnDaemon || null);
        return await daemon.request(getNeedlePython(settings), resolveDaemonScript(), payload);
    } catch (err) {
        return { success: false, error: `needle daemon error: ${err.message || err}` };
    }
}

// Full fast-path for chat surfaces: cheap gate -> warm daemon route ->
// confidence gate -> execute locally. Returns {handled:true, reply} when a
// local tool owned the turn (caller skips heuristic + LLM + background
// learn); {handled:false} otherwise (caller runs the normal LLM flow).

export async function tryNeedleFastPath(text, context, deps = {}) {
    const settings = (context && context.settings) || {};
    if (!isNeedleAutoRoutingEnabled(settings)) return { handled: false };
    if (!isNeedleFastPathCandidate(text)) return { handled: false };
    let res;
    try {
        res = await (deps.routeFn || routeWithNeedle)(String(text), settings, { tools: NEEDLE_DEFAULT_TOOLS, maxTokens: 128 });
    } catch {
        return { handled: false };
    }
    if (!res || !res.success) return { handled: false };
    const calls = Array.isArray(res.function_calls) ? res.function_calls : [];
    if (calls.length === 0) return { handled: false };
    const conf = typeof res.confidence === "number" ? res.confidence : null;
    if (conf !== null && conf < getNeedleMinConfidence(settings)) return { handled: false, lowConfidence: true };
    const exec = deps.executeFn || executeNeedleCall;
    const lines = [];
    for (const call of calls) {
        lines.push(await exec(call, context));
    }
    return { handled: true, reply: lines.join("\n"), result: res };
}
