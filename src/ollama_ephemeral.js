import fs from "node:fs";
import path from "node:path";

/**
 * Ephemeral (one-shot) Ollama inference via the bun-ollama (ollama-lite) CLI.
 *
 * Normal dagowan flow talks to a persistent HTTP daemon (`ollama serve` or
 * `bun-ollama serve`/`daemon`) which keeps the GGUF + KV cache resident in
 * RAM until explicitly stopped (idleTimeout defaults to 0 = never unload).
 *
 * The ephemeral flow instead shells out to:
 *
 *   bun run <ollama-lite-dir>/src/index.ts run <model> --messages-json '<msgs>'
 *
 * (role-labeled history; `ollama_ephemeral_mode: "prompt"` falls back to the
 * legacy flat `run <model> "<prompt>"` form built by buildSinglePrompt()).
 *
 * bun-ollama's `cliRun` (src/cli.ts) does ensureModelReady() -> single-shot
 * streamChatCompletion() -> shutdownAll(). The llama-server child is killed
 * on the way out, so RAM is freed as soon as the answer is done. Cloud
 * (`*-cloud`) models never touch RAM either way (remote inference).
 *
 * This is the DEFAULT for the `ollama` provider in `unifiedChat`
 * (see src/providers.js). Disable per-install with:
 *
 *   @set-setting ollama_ephemeral 0   (or ollama_ephemeral false/off/no)
 *
 * and point at a custom checkout with:
 *
 *   @set-setting ollama_lite_dir /path/to/bun-ollama
 */

export const DEFAULT_EPHEMERAL_TIMEOUT_MS = 180000;

const FALLBACK_LOG_LINE_PREFIXES = [
    "Loading model",
    "Pulling model",
    "Downloading ",
    "Verifying ",
    "Successfully pulled",
    "Model already",
    "Model downloaded",
    "Model loaded",
    "Starting llama-server",
    "Allocated port",
    "Model:",
    "Quantization:",
    "Context:",
    "Remote Host:",
    "Remote Model:",
    "Type \"/exit\"",
    "Ollama Lite",
];

export function isEphemeralEnabled(settings = {}) {
    const v = settings?.ollama_ephemeral;
    if (v === undefined || v === null || v === "") return true;
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0;
    const s = String(v).trim().toLowerCase();
    return !["0", "false", "off", "no", "disabled", "never"].includes(s);
}

/**
 * Ordered candidate locations for the bun-ollama checkout. Fully dynamic —
 * no absolute paths: explicit setting > env var > `ollama-lite` on PATH >
 * sibling of this repo (derived from import.meta.dir, not cwd) > sibling of
 * cwd. The first candidate containing src/index.ts wins.
 */
export function candidateOllamaLiteDirs(settings = {}) {
    const candidates = [];
    if (settings?.ollama_lite_dir) candidates.push(String(settings.ollama_lite_dir));
    if (process.env.OLLAMA_LITE_DIR) candidates.push(process.env.OLLAMA_LITE_DIR);
    try {
        const whichBin = (typeof Bun !== "undefined" && Bun.which) ? Bun.which("ollama-lite") : null;
        if (whichBin) {
            const real = fs.realpathSync(whichBin);
            // Installed shim layout is <liteDir>/bin/ollama-lite.
            const asDir = path.basename(path.dirname(real)) === "bin"
                ? path.dirname(path.dirname(real))
                : path.dirname(real);
            candidates.push(asDir);
        }
    } catch {}
    try {
        // Sibling of this repo, independent of where the process was launched.
        candidates.push(path.resolve(import.meta.dir, "../../bun-ollama"));
    } catch {}
    try {
        candidates.push(path.resolve(process.cwd(), "../bun-ollama"));
    } catch {}
    return [...new Set(candidates.filter(Boolean))];
}

export function resolveOllamaLiteDir(settings = {}) {
    for (const dir of candidateOllamaLiteDirs(settings)) {
        try {
            if (fs.existsSync(path.join(dir, "src", "index.ts"))) return dir;
        } catch {}
    }
    return null;
}

export function resolveOllamaLiteEntry(settings = {}) {
    const dir = resolveOllamaLiteDir(settings);
    return dir ? path.join(dir, "src", "index.ts") : null;
}

/** Status-line prefixes to strip from captured CLI stdout. Overridable via
 *  settings.ollama_ephemeral_strip (array or comma-separated string); when
 *  set it REPLACES the built-in list, so upstream wording changes don't
 *  require a code edit to adapt. */
export function getStripPrefixes(settings = {}) {
    const custom = settings?.ollama_ephemeral_strip;
    if (Array.isArray(custom) && custom.length > 0) return custom.map(String);
    if (typeof custom === "string" && custom.trim()) {
        return custom.split(",").map((s) => s.trim()).filter(Boolean);
    }
    return FALLBACK_LOG_LINE_PREFIXES;
}

/**
 * Collapse an OpenAI-style messages array into the single user-prompt string
 * that `ollama-lite run <model> "<prompt>"` expects.
 */
export function buildSinglePrompt(messages = []) {
    if (!Array.isArray(messages) || messages.length === 0) return "";
    if (messages.length === 1 && messages[0]?.role === "user") {
        return String(messages[0].content ?? "");
    }
    const parts = [];
    for (const m of messages) {
        const role = (m?.role || "user").toLowerCase();
        const content = String(m?.content ?? "").trim();
        if (!content) continue;
        if (role === "system") parts.push(`[System]\n${content}`);
        else if (role === "assistant") parts.push(`Assistant: ${content}`);
        else parts.push(`User: ${content}`);
    }
    // Nudge the model to answer the last user turn, not continue the transcript.
    parts.push("Assistant:");
    return parts.join("\n\n");
}

/**
 * Strip bun-ollama human-CLI status lines ("Loading model ...", download
 * progress, REPL headers) so only the generated answer remains. `cliRun`
 * prints those via console.log to the same stdout as the streamed tokens,
 * so filtering is required when capturing programmatically.
 */
export function sanitizeCliOutput(text = "", settings = {}) {
    const prefixes = getStripPrefixes(settings);
    const raw = String(text ?? "").replace(/\r/g, "\n");
    const lines = raw.split("\n");
    const kept = [];
    for (let line of lines) {
        // Drop ANSI control sequences left over from progress-bar redraws.
        line = line.replace(/\[[0-9;]*[A-Za-z]/g, "");
        const t = line.trim();
        if (!t) continue;
        // bun-ollama's logger writes info/debug to stdout (same stream as
        // the answer tokens), e.g. "[INFO] Model x is now READY on port N".
        // Drop those status lines; real failures surface via exit code +
        // stderr, which runOllamaLiteOnce reports separately.
        if (/^\[(INFO|DEBUG|WARN|WARNING|ERROR)\]/i.test(t)) continue;
        // Progress-bar spam (█/░) from renderProgressBar().
        if (/[█░]{4,}/.test(t)) {
            const stripped = t.replace(/[█░\[\]0-9.%/sBKMGT ]*(Downloading|downloading)[^]*$/g, "").trim();
            if (!stripped || /[█░]/.test(stripped)) continue;
        }
        if (prefixes.some((p) => t.startsWith(p))) continue;
        if (/^Downloading \S+: \[.*\].*/.test(t)) continue;
        if (/^>?\s*(\/exit|\/bye|\/clear|\/help)\b/.test(t)) continue;
        kept.push(line.trimEnd());
    }
    return kept.join("\n").trim();
}

function resolveBunBin() {
    try {
        const found = typeof Bun !== "undefined" && Bun.which ? Bun.which("bun") : null;
        if (found) return found;
    } catch {}
    return process.execPath || "bun";
}

/**
 * Run one ephemeral inference through the bun-ollama CLI.
 * The model process is torn down by `cliRun` itself (shutdownAll),
 * so nothing stays resident in RAM afterwards.
 */
export async function runOllamaLiteOnce({
    model,
    messages = [],
    settings = {},
    onChunk = null,
    timeoutMs = 0,
    stream = true,
} = {}) {
    const modelName = String(model || settings?.model || "").trim();
    if (!modelName) throw new Error("A model name is required (settings.model is empty).");
    if (!Array.isArray(messages) || messages.length === 0) {
        throw new Error("No messages to send to the model.");
    }

    const entry = resolveOllamaLiteEntry(settings);
    if (!entry || !fs.existsSync(entry)) {
        const tried = candidateOllamaLiteDirs(settings);
        throw new Error(
            `bun-ollama checkout not found${tried.length ? ` (tried: ${tried.join(", ")})` : ""}. ` +
            `Set it with @set-setting ollama_lite_dir <dir> or OLLAMA_LITE_DIR.`
        );
    }
    const timeout = Number(timeoutMs || settings?.ollama_ephemeral_timeout_ms || DEFAULT_EPHEMERAL_TIMEOUT_MS);

    const bunBin = resolveBunBin();
    // Default transport: role-labeled history via --messages-json (needs a
    // bun-ollama checkout with run-flags support). "prompt" collapses the
    // turn to one text prompt for older checkouts:
    // @set-setting ollama_ephemeral_mode prompt
    const mode = String(settings?.ollama_ephemeral_mode || "messages").trim().toLowerCase();
    const args = mode === "prompt"
        ? [bunBin, "run", entry, "run", modelName, buildSinglePrompt(messages)]
        : [bunBin, "run", entry, "run", modelName, "--messages-json", JSON.stringify(messages)];
    const proc = Bun.spawn(args, {
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
        cwd: path.dirname(path.dirname(entry)),
        env: { ...process.env },
    });

    let raw = "";
    let emitted = "";
    const decoder = new TextDecoder();
    const emitDelta = () => {
        if (typeof onChunk !== "function") return;
        const clean = sanitizeCliOutput(raw, settings);
        if (clean.length > emitted.length && clean.startsWith(emitted)) {
            const delta = clean.slice(emitted.length);
            emitted = clean;
            if (delta) onChunk(stream ? delta : delta);
        } else if (clean !== emitted && !clean.startsWith(emitted)) {
            // Sanitizer dropped an early header line mid-stream; resync.
            emitted = clean;
            if (clean) onChunk(clean);
        }
    };

    let timedOut = false;
    const killer = timeout > 0 ? setTimeout(() => {
        timedOut = true;
        try { proc.kill("SIGKILL"); } catch {}
    }, timeout) : null;

    try {
        const reader = proc.stdout.getReader();
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
                raw += decoder.decode(value, { stream: true });
                emitDelta();
            }
        }
        try { raw += decoder.decode(); } catch {}
        emitDelta();

        const exitCode = await proc.exited;
        let stderr = "";
        try {
            stderr = await new Response(proc.stderr).text();
        } catch {}
        if (timedOut) {
            throw new Error(`Ephemeral run timed out after ${timeout}ms (model "${modelName}").`);
        }
        if (exitCode !== 0) {
            const tail = String(stderr || "").trim().split("\n").slice(-5).join("\n");
            throw new Error(`ollama-lite run exited with code ${exitCode}${tail ? `: ${tail}` : ""}`);
        }
        const content = sanitizeCliOutput(raw, settings);
        if (!content) {
            const tail = String(stderr || "").trim().split("\n").slice(-5).join("\n");
            throw new Error(
                `ollama-lite run returned an empty reply for model "${modelName}"${tail ? ` (stderr: ${tail})` : ""}.`
            );
        }
        return { content };
    } finally {
        if (killer) clearTimeout(killer);
        try { proc.kill("SIGKILL"); } catch {}
    }
}

export function getEphemeralStatus(settings = {}) {
    return {
        enabled: isEphemeralEnabled(settings),
        liteDir: resolveOllamaLiteDir(settings),
        entry: resolveOllamaLiteEntry(settings),
        timeoutMs: Number(settings?.ollama_ephemeral_timeout_ms || DEFAULT_EPHEMERAL_TIMEOUT_MS),
    };
}

/** Parse an @ephemeral on/off argument. Returns "on" | "off" | "status" | "invalid". */
export function parseEphemeralToggleArg(arg = "") {
    const a = String(arg || "").trim().toLowerCase();
    if (!a || a === "status" || a === "state" || a === "show") return "status";
    if (["on", "true", "1", "enable", "enabled"].includes(a)) return "on";
    if (["off", "false", "0", "disable", "disabled"].includes(a)) return "off";
    return "invalid";
}

/** One shared status/toggle reply so CLI, Telegram, WhatsApp, voice and
 *  dashboard all report the same text. */
export function formatEphemeralReply(settings = {}) {
    const st = getEphemeralStatus(settings);
    const mode = st.enabled
        ? "ENABLED (ON) — each Ollama turn loads the model, answers once, then unloads it (RAM freed)"
        : "DISABLED (OFF) — persistent server, model stays resident in RAM between turns";
    const dir = st.liteDir || "(checkout not found — set via @set-setting ollama_lite_dir <dir> or OLLAMA_LITE_DIR)";
    return `⚡ Ephemeral one-shot Ollama inference: ${mode}\n   • bun-ollama checkout: ${dir}\n   • timeout: ${st.timeoutMs}ms (@set-setting ollama_ephemeral_timeout_ms <ms>)`;
}
