// ---------------------------------------------------------------------------
// @opencode — thin wrapper around the external `opencode` CLI binary.
//
// Unlike @opencli (which drives the OpenAI API directly with a hardcoded
// default model), @opencode shells out to the user's own opencode
// installation (`opencode run --format json <task>`) with the
// project directory as cwd + PWD, so every file operation stays scoped to the
// project and model selection follows the user's setup:
//
//   1. explicit user setting:  @set-setting opencode_model <provider/model>
//      (or @opencode-model <provider/model>)
//   2. otherwise the model already configured in opencode itself
//      (<projectDir>/opencode.json or ~/.config/opencode/opencode.json)
//      — no hardcoded default is ever injected via --model.
//
// The project path is likewise never defaulted: it must be set explicitly
// with @set-project-path <dir> first (the shared settings.project_path).
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const OPENCODE_DEFAULT_BIN = path.join(os.homedir(), ".opencode", "bin", "opencode");
export const OPENCODE_RUN_TIMEOUT_MS = 180000;
export const OPENCODE_CHAT_TRUNCATE_AT = 3500;
export const OPENCODE_LOG_FILE = path.join("logs", "opencode.log");
export const OPENCODE_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
export const OPENCODE_SETUP_LIVE_TIMEOUT_MS = 25000;
export const OPENCODE_SETUP_PROBE_TASK = "Reply with exactly: OPENCODE_SETUP_OK and nothing else";

// The untouched factory value of settings.project_path. Anything still
// exactly this string counts as "not set by the user".
export const OPENCODE_UNSET_PROJECT_PATH = "projects";

export function findOpencodeBin(settings = {}) {
    const explicit = String(settings.opencode_bin || process.env.OPENCODE_BIN || "").trim();
    if (explicit) return explicit;
    try {
        if (fs.existsSync(OPENCODE_DEFAULT_BIN)) return OPENCODE_DEFAULT_BIN;
    } catch {}
    return "opencode"; // fall back to PATH; spawn failure yields a hint
}

// --- config ---------------------------------------------------------------

export function getOpencodeConfig(settings = {}) {
    const timeoutRaw = Number(settings.opencode_timeout_ms ?? OPENCODE_RUN_TIMEOUT_MS);
    let allowed = settings.opencode_allowed_chats ?? [];
    if (typeof allowed === "string") {
        allowed = allowed.split(",").map((s) => s.trim()).filter(Boolean);
    }
    return {
        enabled: settings.opencode_enabled !== false,
        // Empty = no --model flag: opencode uses its own configured model.
        model: String(settings.opencode_model || "").trim(),
        autoApprove: settings.opencode_auto === true || settings.opencode_auto === 1 || settings.opencode_auto === "1",
        timeoutMs: Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? Math.floor(timeoutRaw) : OPENCODE_RUN_TIMEOUT_MS,
        allowedChats: (Array.isArray(allowed) ? allowed : []).map(String),
        bin: findOpencodeBin(settings),
    };
}

// senderId null/undefined = local surface (CLI, Web UI) — always allowed
// when enabled. Remote senders must be listed in opencode_allowed_chats.
export function checkOpencodeAccess(settings = {}, senderId = null) {
    const cfg = getOpencodeConfig(settings);
    if (!cfg.enabled) {
        return { allowed: false, reason: "⚠️ @opencode is disabled (@set-setting opencode_enabled 1 to enable)." };
    }
    if (senderId === null || senderId === undefined || senderId === "") {
        return { allowed: true, local: true };
    }
    if (cfg.allowedChats.includes(String(senderId))) {
        return { allowed: true };
    }
    return {
        allowed: false,
        reason: "⛔ @opencode is owner-gated on this surface. Ask the bot owner to allow your chat:\n@set-setting opencode_allowed_chats [<existing>, \"" + String(senderId) + "\"]",
    };
}

// --- project path (explicit-only, no silent default) ----------------------

export function requireExplicitProjectPath(settings = {}) {
    const raw = settings.project_path || settings.projects_path || "";
    if (!String(raw).trim() || String(raw).trim() === OPENCODE_UNSET_PROJECT_PATH) {
        throw new Error("⚠️ Project path is not set. Set it first: @set-project-path <dir>\nExample: @set-project-path ./projects/my-app");
    }
    let p = String(raw).trim();
    if (p.startsWith("~")) p = path.join(os.homedir(), p.slice(1));
    const abs = path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
    if (!fs.existsSync(abs)) fs.mkdirSync(abs, { recursive: true });
    return abs;
}

// --- model resolution: user setting, else opencode's own config -----------

function stripJsonComments(src) {
    // Minimal JSONC tolerance for opencode.json (// and /* */ comments).
    return String(src || "")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:"\\])\/\/.*$/gm, "$1");
}

export function readOpencodeJsonModel(dir) {
    try {
        const file = path.join(String(dir), "opencode.json");
        if (!fs.existsSync(file)) return "";
        const raw = fs.readFileSync(file, "utf8");
        let parsed = null;
        try {
            parsed = JSON.parse(raw);
        } catch {
            parsed = JSON.parse(stripJsonComments(raw));
        }
        const m = parsed && typeof parsed.model === "string" ? parsed.model.trim() : "";
        return m;
    } catch {
        return "";
    }
}

export function globalOpencodeConfigDir() {
    return path.join(os.homedir(), ".config", "opencode");
}

// Returns { source, model } where source is one of:
// "setting" | "project" | "global" | "none".
export function getEffectiveOpencodeModel(settings = {}, projectPath = null) {
    const fromSetting = String(settings.opencode_model || "").trim();
    if (fromSetting) return { source: "setting", model: fromSetting };
    if (projectPath) {
        const fromProject = readOpencodeJsonModel(projectPath);
        if (fromProject) return { source: "project", model: fromProject };
    }
    const fromGlobal = readOpencodeJsonModel(globalOpencodeConfigDir());
    if (fromGlobal) return { source: "global", model: fromGlobal };
    return { source: "none", model: "" };
}

// --- command construction -------------------------------------------------

export function buildOpencodeArgs({ task, model = "", autoApprove = false }) {
    const args = ["run", "--format", "json"];
    if (model) args.push("--model", model);
    if (autoApprove) args.push("--auto");
    // NOTE: no projectPath positional — `opencode run` takes only message
    // args (see `opencode run --help`). Scoping is via spawn cwd + PWD.
    args.push(String(task));
    return args;
}

// --- output parsing (--format json emits one JSON object per line) ---------

export function parseOpencodeJsonOutput(output) {
    const raw = String(output || "");
    let sessionID = "";
    const texts = [];
    let error = "";
    let parsedAny = false;
    for (const line of raw.split("\n")) {
        const t = line.trim();
        if (!t || !t.startsWith("{")) continue;
        let obj = null;
        try {
            obj = JSON.parse(t);
        } catch {
            continue;
        }
        parsedAny = true;
        if (obj.sessionID && !sessionID) sessionID = String(obj.sessionID);
        const type = obj.type || "";
        if (type === "text" && obj.part && typeof obj.part.text === "string") {
            texts.push(obj.part.text);
        } else if (type === "error") {
            const msg = obj.error?.message || obj.message || "opencode reported an error";
            error = `⚠️ opencode error: ${msg}`;
        }
    }
    if (!parsedAny) {
        // Not JSON-lines at all (e.g. older CLI): treat raw as the reply.
        const fallback = raw.trim();
        return { text: fallback, error: fallback ? "" : "⚠️ opencode returned no output.", sessionID };
    }
    if (error) return { text: texts.join("\n").trim(), error, sessionID };
    const text = texts.join("\n").trim();
    return { text, error: text ? "" : "⚠️ opencode returned no text output.", sessionID };
}

// --- user-facing status messages (shared by CLI / Telegram / Web / WhatsApp) ---

export function shortenOpencodeTask(task, max = 120) {
    const s = String(task || "").replace(/\s+/g, " ").trim();
    if (s.length <= max) return s;
    return s.slice(0, max - 1).trimEnd() + "…";
}

export function formatOpencodeStart(task, { projectPath = "", model = "", modelSource = "" } = {}) {
    const short = shortenOpencodeTask(task);
    const where = projectPath ? `\nProject: ${projectPath}` : "";
    const what = model && model !== "(opencode default)" ? `\nModel: ${model}${modelSource ? ` [${modelSource}]` : ""}` : "";
    return `🤖 opencode task RUNNING: "${short}"${where}${what}\nI'll send a FINISHED message when opencode is done.`;
}

export function formatOpencodeFinish(task, res = {}, elapsedMs = 0) {
    const short = shortenOpencodeTask(task);
    const secs = Math.max(0, Math.round((Number(elapsedMs) || 0) / 1000));
    const when = ` (${secs}s${res.projectPath ? `, ${res.projectPath}` : ""}${res.sessionID ? `, session ${res.sessionID}` : ""})`;
    if (res && res.success) {
        const out = truncateForChat(String(res.output || "").trim());
        return `🤖 opencode task FINISHED successfully: "${short}"${when}\n${out}`;
    }
    const err = String((res && res.error) || "unknown error").slice(0, 800);
    return `⚠️ opencode task FAILED: "${short}"${when}\n${err}`;
}

// --- audit log --------------------------------------------------------------

function appendAudit(entry) {
    try {
        const dir = path.dirname(OPENCODE_LOG_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(OPENCODE_LOG_FILE, JSON.stringify(entry) + "\n", "utf8");
    } catch {}
}

// The opencode CLI resolves its session/project directory from the PWD
// env var — NOT from the process cwd. So spawn `cwd` alone is not enough:
// without an explicit PWD override every task runs in the bot's own
// directory (repo root) and files land there instead of the project.
export function buildOpencodeEnv(projectPath, baseEnv = process.env) {
    return { ...baseEnv, PWD: String(projectPath) };
}

export function truncateForChat(text, limit = OPENCODE_CHAT_TRUNCATE_AT) {
    const s = String(text || "");
    if (s.length <= limit) return s;
    return s.slice(0, limit) + `\n… (truncated for chat; full output in ${OPENCODE_LOG_FILE})`;
}

// --- main entry -------------------------------------------------------------

export async function runOpencodeCommand(taskPrompt, settings = {}, opts = {}) {
    const task = String(taskPrompt || "").trim();
    if (!task) {
        return { success: false, error: "⚠️ Usage: @opencode <project or coding task description>\nExample: @opencode Fix the failing login test in ./web-app" };
    }
    const cfg = getOpencodeConfig(settings);
    if (!cfg.enabled) {
        return { success: false, error: "⚠️ @opencode is disabled (@set-setting opencode_enabled 1 to enable)." };
    }

    let projectPath = "";
    try {
        projectPath = requireExplicitProjectPath(settings);
    } catch (err) {
        return { success: false, error: err.message || String(err) };
    }

    const bin = cfg.bin;
    if (bin !== "opencode") {
        try {
            if (!fs.existsSync(bin)) {
                return { success: false, error: `⚠️ opencode binary not found at ${bin}. Install it (https://opencode.ai) or set @set-setting opencode_bin <path> (or OPENCODE_BIN).` };
            }
        } catch {}
    }

    // No hardcoded model default: explicit setting wins, otherwise opencode
    // itself resolves its configured model (project/global opencode.json).
    // Scoping is via spawn cwd + PWD=projectPath (no path in message args).
    const args = buildOpencodeArgs({ task, model: cfg.model, autoApprove: cfg.autoApprove });
    const effective = cfg.model
        ? { source: "setting", model: cfg.model }
        : getEffectiveOpencodeModel(settings, projectPath);
    const sender = opts.senderId ?? "local";
    const started = Date.now();
    const onStart = typeof opts.onStart === "function" ? opts.onStart : null;
    if (onStart) {
        try {
            await onStart({
                task,
                projectPath,
                model: effective.model || "(opencode default)",
                modelSource: effective.source,
                startMessage: formatOpencodeStart(task, {
                    projectPath,
                    model: effective.model || "(opencode default)",
                    modelSource: effective.source,
                }),
            });
        } catch {}
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    // Scoping is via spawn cwd + PWD=projectPath (the CLI reads PWD,
    // not the process cwd, to pick its session/project directory).
    const spawnEnv = buildOpencodeEnv(projectPath);
    const exitCode = await new Promise((resolve) => {
        let proc = null;
        try {
            proc = spawn(bin, args, { cwd: projectPath, env: spawnEnv, stdio: ["ignore", "pipe", "pipe"] });
        } catch (err) {
            stderr = err.message || String(err);
            resolve(null);
            return;
        }
        const timer = setTimeout(() => {
            timedOut = true;
            try {
                proc.kill("SIGKILL");
            } catch {}
        }, cfg.timeoutMs);
        proc.stdout?.on("data", (d) => {
            if (stdout.length < OPENCODE_MAX_OUTPUT_BYTES) stdout += String(d);
        });
        proc.stderr?.on("data", (d) => {
            if (stderr.length < 256 * 1024) stderr += String(d);
        });
        proc.on("error", (err) => {
            clearTimeout(timer);
            stderr += err.message || String(err);
            resolve(null);
        });
        proc.on("close", (code) => {
            clearTimeout(timer);
            resolve(code);
        });
    });

    if (timedOut) {
        const msg = `⚠️ @opencode timed out after ${Math.round(cfg.timeoutMs / 1000)}s. Partial work (if any) is in ${projectPath}; trace in ${OPENCODE_LOG_FILE}.`;
        appendAudit({ ts: new Date().toISOString(), sender, model: effective.model || "(opencode default)", task: task.slice(0, 300), tool: "__timeout__", ok: false, ms: Date.now() - started });
        return { success: false, error: msg, model: effective.model, projectPath, elapsedMs: Date.now() - started, timedOut: true };
    }
    if (exitCode === null && !stdout) {
        const hint = /ENOENT|not found/i.test(stderr)
            ? `⚠️ Could not start opencode binary ("${bin}"). Install it (https://opencode.ai) or set @set-setting opencode_bin <path>.`
            : `⚠️ Failed to start opencode: ${stderr.trim().slice(0, 500) || "unknown error"}`;
        return { success: false, error: hint, model: effective.model, projectPath, elapsedMs: Date.now() - started };
    }

    const parsed = parseOpencodeJsonOutput(stdout);
    appendAudit({
        ts: new Date().toISOString(), sender,
        model: effective.model || "(opencode default)", modelSource: effective.source,
        task: task.slice(0, 300), sessionID: parsed.sessionID || "",
        exitCode, ok: !parsed.error, ms: Date.now() - started,
    });
    if (parsed.error && !parsed.text) {
        const extra = stderr.trim() ? `\n${stderr.trim().slice(0, 500)}` : "";
        return { success: false, error: `${parsed.error}${extra}`, model: effective.model, modelSource: effective.source, projectPath, sessionID: parsed.sessionID, elapsedMs: Date.now() - started };
    }
    return {
        success: true,
        model: effective.model || "(opencode default)",
        modelSource: effective.source,
        projectPath,
        output: parsed.text,
        sessionID: parsed.sessionID,
        elapsedMs: Date.now() - started,
    };
}

// --- guided setup (@opencode-setup) ----------------------------------------
// Single-shot subcommands (status/path/model/models/auth/auto/auto-allow/test)
// so the same flow works on CLI, Telegram, WhatsApp and Web UI without
// carrying multi-turn wizard state per surface.
//
// `auto on|off` toggles the CLI `--auto` flag (auto-approve asks at runtime).
// `auto-allow ...` writes persistent `permission` presets into
// <projectDir>/opencode.json so file creation/editing/review inside the
// project never prompts (read/edit/glob/grep allow, plus mode-specific
// bash handling). The standalone alias `@opencode-setup-auto-allow` on all
// surfaces forwards to the `auto-allow` subcommand.

// --- project opencode.json permission presets (auto-allow) ------------------
// `edit` covers all file modifications (edit/write/patch = file creation +
// adding). `read`/`glob`/`grep` cover reviewing/searching. Presets are merged
// into <projectDir>/opencode.json, preserving existing keys (model, $schema…).
export const OPENCODE_AUTO_ALLOW_MODES = ["full", "safe", "review"];
export const OPENCODE_AUTO_ALLOW_PERMISSIONS = {
    // Hands-free: file ops + shell/tools run without prompting.
    // (Explicit "deny" elsewhere still wins; `--auto` only auto-approves "ask".)
    full: {
        read: "allow",
        edit: "allow",
        glob: "allow",
        grep: "allow",
        bash: "allow",
        task: "allow",
        skill: "allow",
        webfetch: "allow",
        websearch: "allow",
    },
    // File ops hands-free, shell still asks (safer for untrusted tasks).
    safe: {
        read: "allow",
        edit: "allow",
        glob: "allow",
        grep: "allow",
        bash: "ask",
        task: "allow",
        skill: "allow",
        webfetch: "allow",
        websearch: "allow",
    },
    // Review-only: read/search allowed, edits blocked.
    review: {
        read: "allow",
        glob: "allow",
        grep: "allow",
        webfetch: "allow",
        websearch: "allow",
        edit: "deny",
        bash: "ask",
    },
};

export function readProjectOpencodeJson(projectPath) {
    const file = path.join(String(projectPath), "opencode.json");
    try {
        if (!fs.existsSync(file)) return { exists: false, file, data: {}, raw: "" };
        const raw = fs.readFileSync(file, "utf8");
        let data = {};
        try {
            data = JSON.parse(raw);
        } catch {
            data = JSON.parse(stripJsonComments(raw));
        }
        if (!data || typeof data !== "object" || Array.isArray(data)) data = {};
        return { exists: true, file, data, raw };
    } catch {
        return { exists: false, file, data: {}, raw: "" };
    }
}

function writeProjectOpencodeJson(projectPath, data) {
    const file = path.join(String(projectPath), "opencode.json");
    if (!data || typeof data !== "object" || Array.isArray(data)) data = {};
    if (!data.$schema) data.$schema = "https://opencode.ai/config.json";
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8");
    return file;
}

function resolvePermissionValue(permission, key) {
    if (permission === "allow") return "allow";
    if (permission === "ask") return "ask";
    if (permission === "deny") return "deny";
    if (permission && typeof permission === "object" && !Array.isArray(permission)) {
        const v = permission[key];
        if (typeof v === "string") return v.toLowerCase();
        if (v && typeof v === "object") {
            // Granular object syntax (e.g. bash: { "*": "ask", ... }) —
            // report the catch-all when present, else "mixed".
            const wild = v["*"] ?? v[""] ?? null;
            if (typeof wild === "string") return `mixed(${wild.toLowerCase()}+rules)`;
            return "mixed(rules)";
        }
        return "";
    }
    return "";
}

// Offline check: does <projectDir>/opencode.json already auto-allow file ops?
export function getOpencodeAutoAllowStatus(settings = {}) {
    let projectPath = "";
    try {
        projectPath = requireExplicitProjectPath(settings);
    } catch (err) {
        return { state: "no-project", mode: "", file: "", detail: err.message || String(err) };
    }
    const { exists, file, data } = readProjectOpencodeJson(projectPath);
    if (!exists) return { state: "missing", mode: "", file, detail: "no opencode.json yet — run @opencode-setup auto-allow to create one" };
    const perm = data.permission;
    if (perm === "allow") return { state: "full", mode: "full", file, detail: 'permission is globally "allow"' };
    if (!perm || typeof perm !== "object" || Array.isArray(perm)) {
        return { state: "missing", mode: "", file, detail: "no permission section — run @opencode-setup auto-allow" };
    }
    const read = resolvePermissionValue(perm, "read");
    const edit = resolvePermissionValue(perm, "edit");
    const glob = resolvePermissionValue(perm, "glob");
    const grep = resolvePermissionValue(perm, "grep");
    const bash = resolvePermissionValue(perm, "bash");
    const fileOpsAllow = (v) => v === "allow";
    if (edit === "deny" && fileOpsAllow(read)) {
        return { state: "review", mode: "review", file, detail: `review-only (read ${read}, edit deny) in ${file}` };
    }
    if (fileOpsAllow(read) && fileOpsAllow(edit) && fileOpsAllow(glob) && fileOpsAllow(grep)) {
        if (bash === "allow") return { state: "full", mode: "full", file, detail: `file ops + bash allowed in ${file}` };
        return { state: "safe", mode: "safe", file, detail: `file ops allowed, bash ${bash || "unset"} in ${file}` };
    }
    const bits = [`read ${read || "-"}`, `edit ${edit || "-"}`, `glob ${glob || "-"}`, `grep ${grep || "-"}`, `bash ${bash || "-"}`];
    return { state: "partial", mode: "", file, detail: `partial permissions (${bits.join(", ")}) in ${file}` };
}

export function formatOpencodeAutoAllowStatus(st) {
    if (!st) return "auto-allow: unknown";
    if (st.state === "no-project") return `auto-allow: no project path — ${st.detail}`;
    if (st.state === "missing") return `auto-allow ✗: ${st.detail}`;
    const mark = st.state === "full" || st.state === "safe" || st.state === "review" ? "✓" : "?";
    return `auto-allow ${mark} [${st.mode || st.state}]: ${st.detail}`;
}

// Write a permission preset into <projectDir>/opencode.json (merged).
export function applyOpencodeAutoAllow(settings = {}, mode = "full") {
    const m = String(mode || "full").toLowerCase();
    if (!OPENCODE_AUTO_ALLOW_MODES.includes(m)) {
        return { success: false, error: `⚠️ Unknown auto-allow mode "${mode}". Use: ${OPENCODE_AUTO_ALLOW_MODES.join("|")} (or status|clear)` };
    }
    let projectPath = "";
    try {
        projectPath = requireExplicitProjectPath(settings);
    } catch (err) {
        return { success: false, error: err.message || String(err) };
    }
    const preset = OPENCODE_AUTO_ALLOW_PERMISSIONS[m];
    const { data } = readProjectOpencodeJson(projectPath);
    const current = data.permission && typeof data.permission === "object" && !Array.isArray(data.permission)
        ? { ...data.permission }
        : (typeof data.permission === "string" ? {} : {});
    // Merge preset over existing permission keys; never touch unrelated keys.
    const next = { ...current, ...preset };
    const out = { ...data, permission: next };
    let file = "";
    try {
        if (!fs.existsSync(projectPath)) fs.mkdirSync(projectPath, { recursive: true });
        file = writeProjectOpencodeJson(projectPath, out);
    } catch (err) {
        return { success: false, error: `⚠️ Could not write ${projectPath}/opencode.json: ${err.message || err}` };
    }
    return { success: true, mode: m, file, projectPath, permission: next };
}

// Remove the permission keys managed by auto-allow (keeps model/$schema/etc).
export function clearOpencodeAutoAllow(settings = {}) {
    let projectPath = "";
    try {
        projectPath = requireExplicitProjectPath(settings);
    } catch (err) {
        return { success: false, error: err.message || String(err) };
    }
    const { exists, data } = readProjectOpencodeJson(projectPath);
    if (!exists) return { success: false, error: `⚠️ No ${projectPath}/opencode.json to clear.` };
    const managed = ["read", "edit", "glob", "grep", "bash", "task", "skill", "webfetch", "websearch"];
    if (typeof data.permission === "string") {
        delete data.permission;
    } else if (data.permission && typeof data.permission === "object") {
        for (const k of managed) delete data.permission[k];
        if (Object.keys(data.permission).length === 0) delete data.permission;
    } else {
        return { success: false, error: "⚠️ No permission section to clear." };
    }
    try {
        const file = writeProjectOpencodeJson(projectPath, data);
        return { success: true, file, projectPath };
    } catch (err) {
        return { success: false, error: `⚠️ Could not update ${projectPath}/opencode.json: ${err.message || err}` };
    }
}

async function runBinLive(bin, args, timeoutMs = OPENCODE_SETUP_LIVE_TIMEOUT_MS) {
    try {
        const { stdout } = await execFileAsync(bin, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 });
        return { ok: true, output: String(stdout || "").trim() };
    } catch (err) {
        return { ok: false, output: String(err.stdout || "").trim(), error: err.message || String(err) };
    }
}

export async function getOpencodeSetupStatus(settings = {}, opts = {}) {
    const live = opts.live !== false;
    const cfg = getOpencodeConfig(settings);

    const binary = { ok: false, bin: cfg.bin, version: "" };
    if (cfg.bin === "opencode") {
        binary.ok = true; // resolved via PATH; a spawn failure surfaces in live checks
    } else {
        try {
            binary.ok = fs.existsSync(cfg.bin);
        } catch {
            binary.ok = false;
        }
    }
    if (binary.ok && live) {
        const v = await runBinLive(cfg.bin, ["--version"], 10000);
        if (v.ok) binary.version = v.output.split("\n")[0].slice(0, 40);
        else binary.ok = false;
    }

    let project = { ok: false, path: "", error: "" };
    try {
        project = { ok: true, path: requireExplicitProjectPath(settings), error: "" };
    } catch (err) {
        project = { ok: false, path: "", error: err.message || String(err) };
    }

    const model = getEffectiveOpencodeModel(settings, project.ok ? project.path : null);

    let auth = { state: "skipped", detail: live ? "" : "live check skipped" };
    let models = { state: "skipped", count: 0, sample: [] };
    if (live && binary.ok) {
        const a = await runBinLive(cfg.bin, ["auth", "list"]);
        if (!a.ok && !a.output) {
            auth = { state: "unknown", detail: `could not query auth (${(a.error || "").slice(0, 120)})` };
        } else if (/no authenticated/i.test(a.output)) {
            auth = { state: "missing", detail: "No authenticated integrations — free/shared models may still work; log in for full access." };
        } else {
            auth = { state: "ok", detail: a.output.split("\n").filter(Boolean).slice(0, 3).join(" | ").slice(0, 200) || "authenticated" };
        }
        const m = await runBinLive(cfg.bin, ["models"]);
        if (m.ok) {
            const lines = m.output.split("\n").map((s) => s.trim()).filter(Boolean);
            models = { state: "ok", count: lines.length, sample: lines.slice(0, 15) };
        } else {
            models = { state: "unknown", detail: `could not list models (${(m.error || "").slice(0, 120)})` };
        }
    }

    const access = {
        allowedChats: cfg.allowedChats,
        autoApprove: cfg.autoApprove,
        timeoutMs: cfg.timeoutMs,
    };
    const permissions = getOpencodeAutoAllowStatus(settings);
    const ready = binary.ok && project.ok && !!model.model;
    return { ready, enabled: cfg.enabled, binary, project, model, auth, models, access, permissions };
}

export function formatOpencodeSetupStatus(st) {
    const mark = (ok) => (ok ? "✓" : "✗");
    const lines = [];
    lines.push(`🔧 opencode setup ${st.ready ? "— READY ✓" : "— NOT READY YET"}`);
    lines.push(`1. Binary ${mark(st.binary.ok)}: ${st.binary.bin}${st.binary.version ? ` (${st.binary.version})` : ""}`);
    if (!st.binary.ok) lines.push("   → Install: https://opencode.ai — or point at it: @opencode-setup bin <path> (also: @set-setting opencode_bin <path>)");
    lines.push(`2. Project path ${mark(st.project.ok)}: ${st.project.ok ? st.project.path : "not set"}`);
    if (!st.project.ok) lines.push("   → Fix: @opencode-setup path <dir>  (e.g. @opencode-setup path ./projects/my-app)");
    lines.push(`3. Model ${mark(!!st.model.model)}: ${st.model.model || "(none)"} [${st.model.source}]`);
    if (!st.model.model) lines.push("   → Fix: @opencode-setup model <provider/model>  (e.g. @opencode-setup model ollama/qwen3:8b)");
    else if (st.model.source !== "setting") lines.push("   → Override anytime: @opencode-setup model <provider/model>  (clear with @opencode-setup model clear)");
    const authMark = st.auth.state === "ok" ? "✓" : st.auth.state === "missing" ? "○" : st.auth.state === "skipped" ? "·" : "?";
    lines.push(`4. Auth ${authMark}: ${st.auth.detail || st.auth.state}`);
    if (st.auth.state === "missing") lines.push("   → Optional: run `opencode auth login` in a terminal for full model access");
    if (st.models.state === "ok") lines.push(`5. Models: ${st.models.count} available (see @opencode-setup models)`);
    const permMark = st.permissions && (st.permissions.state === "full" || st.permissions.state === "safe" || st.permissions.state === "review") ? "✓" : "○";
    lines.push(`6. Auto-allow ${permMark}: ${st.permissions ? (st.permissions.detail || st.permissions.state) : "unknown"}`);
    if (!st.permissions || !["full", "safe", "review"].includes(st.permissions.state)) lines.push("   → Fix: @opencode-setup auto-allow (full|safe|review) — or @opencode-setup-auto-allow");
    if (!st.enabled) lines.push("⚠️ @opencode is disabled — enable: @set-setting opencode_enabled 1");
    lines.push(st.ready
        ? "Next: verify end-to-end with @opencode-setup test"
        : "Next: run the ✗ step above, then re-check with @opencode-setup");
    return lines.join("\n");
}

export const OPENCODE_SETUP_USAGE =
    "⚠️ Usage: @opencode-setup [status|path <dir>|model <m>|model clear|models|auth|bin <path>|auto on|off|auto-allow [full|safe|review|status|clear]|test [task]]" +
    "\nExamples:\n@opencode-setup\n@opencode-setup path ./projects/my-app\n@opencode-setup model ollama/qwen3:8b\n@opencode-setup auto-allow\n@opencode-setup test" +
    "\nAlias: @opencode-setup-auto-allow [full|safe|review|status|clear]";

// One setup subcommand. Mutates `settings` in place; surfaces persist it
// when `settingsChanged` is true. `senderId` is used for the test probe audit.
export async function runOpencodeSetupStep(rawArgs, settings = {}, opts = {}) {
    const args = String(rawArgs || "").trim();
    const [verbRaw, ...rest] = args.split(/\s+/).filter(Boolean);
    const verb = (verbRaw || "status").toLowerCase();
    const tail = rest.join(" ").trim();

    if (verb === "status") {
        const st = await getOpencodeSetupStatus(settings, opts);
        return { reply: formatOpencodeSetupStatus(st), settingsChanged: false, status: st };
    }

    if (verb === "path") {
        if (!tail) return { reply: "⚠️ Usage: @opencode-setup path <dir>\nExample: @opencode-setup path ./projects/my-app" };
        let p = tail;
        if (p.startsWith("~")) p = path.join(os.homedir(), p.slice(1));
        const abs = path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
        try {
            if (!fs.existsSync(abs)) fs.mkdirSync(abs, { recursive: true });
        } catch (err) {
            return { reply: `⚠️ Could not create ${abs}: ${err.message || err}` };
        }
        settings.project_path = abs;
        return { reply: `📁 opencode project path set: "${abs}"\nNext: @opencode-setup model <provider/model> (or rely on ${abs}/opencode.json), then @opencode-setup test`, settingsChanged: true };
    }

    if (verb === "model") {
        if (!tail) {
            const st = await getOpencodeSetupStatus(settings, { ...opts, live: false });
            return { reply: `🤖 @opencode model: ${st.model.model || "(opencode default)"} [${st.model.source}]\nSet: @opencode-setup model <provider/model> — clear: @opencode-setup model clear` };
        }
        if (tail.toLowerCase() === "clear") {
            settings.opencode_model = "";
            return { reply: "🤖 @opencode model cleared — opencode's own configured model will be used.", settingsChanged: true };
        }
        settings.opencode_model = tail;
        return { reply: `🤖 @opencode model set to "${tail}"\nNext: @opencode-setup test`, settingsChanged: true };
    }

    if (verb === "models") {
        const st = await getOpencodeSetupStatus(settings, opts);
        if (st.models.state !== "ok") {
            return { reply: `⚠️ Could not list models (${st.models.detail || st.models.state}). Is the opencode binary installed?`, status: st };
        }
        const shown = st.models.sample.join("\n");
        const more = st.models.count > st.models.sample.length ? `\n… +${st.models.count - st.models.sample.length} more` : "";
        return { reply: `🤖 Available opencode models (${st.models.count}):\n${shown}${more}\nPick one: @opencode-setup model <provider/model>`, status: st };
    }

    if (verb === "auth") {
        const st = await getOpencodeSetupStatus(settings, opts);
        const extra = st.auth.state === "missing" ? "\nTo log in, run `opencode auth login` in a terminal, then re-check with @opencode-setup auth" : "";
        return { reply: `🔑 opencode auth: ${st.auth.detail || st.auth.state}${extra}`, status: st };
    }

    if (verb === "bin") {
        if (!tail) return { reply: "⚠️ Usage: @opencode-setup bin <path-to-opencode-binary>" };
        settings.opencode_bin = tail;
        return { reply: `🔧 opencode binary set to "${tail}"\nNext: @opencode-setup`, settingsChanged: true };
    }

    if (verb === "auto") {
        const v = tail.toLowerCase();
        if (v !== "on" && v !== "off") return { reply: "⚠️ Usage: @opencode-setup auto on|off" };
        settings.opencode_auto = v === "on";
        return { reply: `🤖 opencode --auto approvals ${v === "on" ? "ENABLED (opencode may edit/run without asking)" : "disabled"}.`, settingsChanged: true };
    }

    if (verb === "auto-allow" || verb === "autoallow") {
        const sub = (tail.split(/\s+/).filter(Boolean)[0] || "").toLowerCase();
        if (!sub || sub === "full" || sub === "safe" || sub === "review" || sub === "on") {
            const mode = sub === "on" ? "full" : (sub || "full");
            const res = applyOpencodeAutoAllow(settings, mode);
            if (!res.success) return { reply: res.error };
            const keys = Object.entries(OPENCODE_AUTO_ALLOW_PERMISSIONS[res.mode]).map(([k, v]) => `${k}=${v}`).join(", ");
            const autoHint = getOpencodeConfig(settings).autoApprove
                ? "Runtime --auto is ON (@opencode-setup auto on)."
                : "Tip: also enable runtime auto-approve with @opencode-setup auto on.";
            return { reply: `✅ opencode auto-allow [${res.mode}] written to ${res.file}\nPermissions: ${keys}\nFile creation/editing + reviewing inside ${res.projectPath} will not prompt.\n${autoHint}\nVerify: @opencode-setup test` };
        }
        if (sub === "status" || sub === "show" || sub === "check") {
            const st = getOpencodeAutoAllowStatus(settings);
            return { reply: `🔐 ${formatOpencodeAutoAllowStatus(st)}` };
        }
        if (sub === "clear" || sub === "off" || sub === "remove" || sub === "reset") {
            const res = clearOpencodeAutoAllow(settings);
            if (!res.success) return { reply: res.error };
            return { reply: `🧹 opencode auto-allow permissions cleared from ${res.file}\nFile ops will prompt again (defaults: most allow, external_directory/doom_loop ask).` };
        }
        return { reply: "⚠️ Usage: @opencode-setup auto-allow [full|safe|review|status|clear]\n• full = file ops + bash allow (hands-free)\n• safe = file ops allow, bash asks\n• review = read-only (edit deny)\nAlias: @opencode-setup-auto-allow [mode]" };
    }

    if (verb === "test") {
        const res = await runOpencodeCommand(tail || OPENCODE_SETUP_PROBE_TASK, settings, opts);
        if (!res.success) return { reply: `🔧 Setup test FAILED:\n${res.error}\nRecheck: @opencode-setup` };
        const out = String(res.output || "").slice(0, 500);
        return { reply: `🔧 Setup test PASSED ✓ (model: ${res.model} [${res.modelSource}], project: ${res.projectPath})\n${out}` };
    }

    return { reply: OPENCODE_SETUP_USAGE };
}
