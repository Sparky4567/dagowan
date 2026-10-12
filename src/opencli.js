// ---------------------------------------------------------------------------
// @opencli — API-driven OpenAI coding agent with safety rails.
//
// Unlike @make (which only executes tools for local Ollama models and falls
// back to advisory text for cloud models), @opencli always runs a real
// tool loop against the OpenAI API: read/list/write/search files plus
// host shell commands, all jailed to the project directory.
//
// Safety rails (see README "OpenCLI" section):
//   - explicit trigger only — never auto-routed, kept out of Needle fast-path
//   - every file path is contained inside the project dir (absolute-path and
//     ../ escapes are refused, unlike the legacy resolvePath behaviour)
//   - run_command is forced to cwd=project dir, runs with secrets scrubbed
//     from its environment, and refuses destructive patterns
//   - remote surfaces (Telegram/WhatsApp) are owner-gated via
//     opencli_allowed_chats; CLI/Web UI count as local
//   - iteration cap + overall timeout + per-run JSONL audit log
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import OpenAI from "openai";
import { executeTool } from "../ollama_cli/src/tools.ts";
import { resolveProjectPath } from "./ollama_coding.js";
import { getApiKey } from "./providers.js";

const execAsync = promisify(exec);

export const OPENCLI_DEFAULT_MODEL = "gpt-4o-mini";
export const OPENCLI_DEFAULT_MAX_ITERATIONS = 12;
export const OPENCLI_CMD_TIMEOUT_MS = 30000;
export const OPENCLI_RUN_TIMEOUT_MS = 180000;
export const OPENCLI_CHAT_TRUNCATE_AT = 3500;
export const OPENCLI_LOG_FILE = path.join("logs", "opencli.log");

// Tools the model may call. Mirrors the safe subset of ollama_cli TOOLS;
// run_command deliberately omits `cwd` (always forced to the project dir).
const OPENCLI_TOOLS = [
    {
        type: "function",
        function: {
            name: "read_file",
            description: "Read a file inside the project directory. Paths are jailed — absolute paths and .. escapes are refused.",
            parameters: {
                type: "object",
                properties: {
                    file_path: { type: "string", description: "Project-relative file path." },
                    start_line: { type: "integer", description: "Optional 1-indexed start line." },
                    end_line: { type: "integer", description: "Optional 1-indexed end line (inclusive)." },
                },
                required: ["file_path"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "list_directory",
            description: "List a directory inside the project directory.",
            parameters: {
                type: "object",
                properties: {
                    directory_path: { type: "string", description: "Project-relative directory ('.' for root)." },
                },
            },
        },
    },
    {
        type: "function",
        function: {
            name: "write_file",
            description: "Write content to a file inside the project directory (parents auto-created).",
            parameters: {
                type: "object",
                properties: {
                    file_path: { type: "string", description: "Project-relative file path including filename." },
                    content: { type: "string", description: "Text content to write." },
                },
                required: ["file_path", "content"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "run_command",
            description: "Run a shell command with the project directory as cwd (30s limit). Destructive commands are refused; secrets are scrubbed from the environment.",
            parameters: {
                type: "object",
                properties: {
                    command: { type: "string", description: "Shell command to execute." },
                },
                required: ["command"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "search_files",
            description: "Grep for text inside the project directory.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Text or regex to search for." },
                    directory_path: { type: "string", description: "Project-relative directory ('.' for root)." },
                },
                required: ["query"],
            },
        },
    },
];

// --- config ---------------------------------------------------------------

export function getOpenCliConfig(settings = {}) {
    const maxIt = Number(settings.opencli_max_iterations ?? OPENCLI_DEFAULT_MAX_ITERATIONS);
    let allowed = settings.opencli_allowed_chats ?? [];
    if (typeof allowed === "string") {
        allowed = allowed.split(",").map((s) => s.trim()).filter(Boolean);
    }
    return {
        enabled: settings.opencli_enabled !== false,
        model: settings.opencli_model || OPENCLI_DEFAULT_MODEL,
        maxIterations: Number.isFinite(maxIt) && maxIt > 0 ? Math.min(Math.floor(maxIt), 50) : OPENCLI_DEFAULT_MAX_ITERATIONS,
        allowedChats: (Array.isArray(allowed) ? allowed : []).map(String),
    };
}

// senderId null/undefined = local surface (CLI, Web UI) — always allowed
// when enabled. Remote senders must be listed in opencli_allowed_chats.
export function checkOpenCliAccess(settings = {}, senderId = null) {
    const cfg = getOpenCliConfig(settings);
    if (!cfg.enabled) {
        return { allowed: false, reason: "⚠️ @opencli is disabled (@set-setting opencli_enabled 1 to enable)." };
    }
    if (senderId === null || senderId === undefined || senderId === "") {
        return { allowed: true, local: true };
    }
    if (cfg.allowedChats.includes(String(senderId))) {
        return { allowed: true };
    }
    return {
        allowed: false,
        reason: "⛔ @opencli is owner-gated on this surface. Ask the bot owner to allow your chat:\n@set-setting opencli_allowed_chats [<existing>, \"" + String(senderId) + "\"]",
    };
}

// --- jail -----------------------------------------------------------------

// Resolve `target` against project `root`; throw when it escapes the jail.
// Unlike ollama_cli resolvePath, absolute paths outside root are refused.
export function resolveJailedPath(targetPath, root) {
    const rootAbs = path.resolve(root);
    let target = String(targetPath || ".");
    if (target.startsWith("~")) throw new Error(`Path escapes project jail: ${targetPath}`);
    const abs = path.isAbsolute(target) ? path.resolve(target) : path.resolve(rootAbs, target);
    if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) {
        throw new Error(`Path escapes project jail: ${targetPath}`);
    }
    return abs;
}

const DESTRUCTIVE_PATTERNS = [
    { re: /:\(\)\s*\{/, reason: "fork bomb" },
    { re: /\bmkfs\b/, reason: "filesystem formatting" },
    { re: /\bdd\s+[^;|&]*of=\/dev\//, reason: "raw device write" },
    { re: />\s*\/dev\/[a-z]/, reason: "device write redirect" },
    { re: /\brm\s+(-[a-z]*r[a-z]*\s+)..?(\s|$)/, reason: "recursive delete of / or ~" },
    { re: /\brm\s+(-[a-z]*r[a-z]*\s+)+\/\*/, reason: "recursive delete of /*" },
    { re: /\bchmod\s+-R\s+777\s+\//, reason: "chmod -R 777 /" },
];

export function checkDestructiveCommand(cmd) {
    const c = String(cmd || "");
    for (const p of DESTRUCTIVE_PATTERNS) {
        if (p.re.test(c)) return { blocked: true, reason: p.reason };
    }
    return { blocked: false };
}

// Copy of process.env minus anything that looks like a credential, so a
// `run_command` payload can never `echo $OPENAI_API_KEY`-style exfiltrate.
export function scrubSecretsEnv(env = process.env) {
    const out = {};
    for (const [k, v] of Object.entries(env || {})) {
        if (/api[_-]?key|auth[_-]?token|[^a-z]token$|_token\b|secret|password|private[_-]?key/i.test(k)) continue;
        out[k] = v;
    }
    return out;
}

async function runJailedCommand(cmd, projectPath) {
    const verdict = checkDestructiveCommand(cmd);
    if (verdict.blocked) {
        return `Refused: destructive command pattern (${verdict.reason}). Ask the user for a safer alternative.`;
    }
    try {
        const { stdout, stderr } = await execAsync(String(cmd), {
            cwd: projectPath,
            timeout: OPENCLI_CMD_TIMEOUT_MS,
            maxBuffer: 10 * 1024 * 1024,
            env: scrubSecretsEnv(),
        });
        let output = "";
        if ((stdout || "").trim()) output += `STDOUT:\n${stdout.trim()}\n`;
        if ((stderr || "").trim()) output += `STDERR:\n${stderr.trim()}\n`;
        return output.trim() || "Command executed successfully with no output.";
    } catch (err) {
        return `Command failed (exit ${err.code ?? 1})\n${err.stdout ? "STDOUT: " + String(err.stdout).trim() : ""}\n${err.stderr ? "STDERR: " + String(err.stderr).trim() : ""}`.trim();
    }
}

export async function executeJailedTool(name, args = {}, projectPath) {
    try {
        if (name === "run_command") {
            if (!args.command) return "Error: run_command needs a `command`.";
            return await runJailedCommand(args.command, projectPath);
        }
        if (["read_file", "write_file", "list_directory", "search_files"].includes(name)) {
            const pathArg = args.file_path ?? args.directory_path;
            if (name !== "search_files" && !pathArg) return `Error: ${name} needs a file/directory path.`;
            if (pathArg) resolveJailedPath(pathArg, projectPath); // throws on escape
            return await executeTool(name, args, projectPath);
        }
        return `Error: tool '${name}' is not available in @opencli.`;
    } catch (err) {
        return `Error: ${err.message || err}`;
    }
}

// --- agent loop ------------------------------------------------------------

function appendAudit(entry) {
    try {
        const dir = path.dirname(OPENCLI_LOG_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(OPENCLI_LOG_FILE, JSON.stringify(entry) + "\n", "utf8");
    } catch {}
}

export function truncateForChat(text, limit = OPENCLI_CHAT_TRUNCATE_AT) {
    const s = String(text || "");
    if (s.length <= limit) return s;
    return s.slice(0, limit) + `\n… (truncated for chat; full output in ${OPENCLI_LOG_FILE})`;
}

export async function runOpenCliCommand(taskPrompt, settings = {}, opts = {}) {
    const task = String(taskPrompt || "").trim();
    if (!task) {
        return { success: false, error: "⚠️ Usage: @opencli <project or coding task description>\nExample: @opencli Scaffold a bun + sqlite todo API in ./todo-api with tests" };
    }
    const cfg = getOpenCliConfig(settings);
    if (!cfg.enabled) {
        return { success: false, error: "⚠️ @opencli is disabled (@set-setting opencli_enabled 1 to enable)." };
    }
    const apiKey = getApiKey("openai", settings);
    if (!apiKey) {
        return { success: false, error: "⚠️ @opencli needs an OpenAI key: @set-api-key openai <key> (or OPENAI_API_KEY)." };
    }

    const projectPath = resolveProjectPath(settings);
    const sender = opts.senderId ?? "local";
    const started = Date.now();
    const client = new OpenAI({ apiKey });
    const messages = [
        {
            role: "system",
            content: `You are an expert coding agent working inside the project directory: ${projectPath}\nRules:\n- All file paths must stay inside the project directory (escapes are refused).\n- Shell commands run with the project directory as cwd and a 30s limit; destructive commands are refused.\n- Prefer small, verifiable steps: explore first (list_directory/read_file), then change, then verify (run_command).\n- When finished, reply with a concise summary: files created/changed + how to run/verify. Do not claim tool results you did not receive.`,
        },
        { role: "user", content: task },
    ];

    let iterations = 0;
    let finalText = "";
    const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`run exceeded ${OPENCLI_RUN_TIMEOUT_MS / 1000}s budget`)), OPENCLI_RUN_TIMEOUT_MS)
    );

    try {
        await Promise.race([
            (async () => {
                for (let i = 0; i < cfg.maxIterations; i++) {
                    iterations = i + 1;
                    const res = await client.chat.completions.create({
                        model: cfg.model,
                        messages,
                        tools: OPENCLI_TOOLS,
                        tool_choice: "auto",
                    });
                    const msg = res.choices[0]?.message;
                    if (!msg) break;
                    messages.push(msg);
                    const calls = msg.tool_calls || [];
                    if (calls.length === 0) {
                        finalText = msg.content || "Done (no summary returned).";
                        break;
                    }
                    for (const call of calls) {
                        let tArgs = {};
                        try { tArgs = JSON.parse(call.function?.arguments || "{}"); } catch { tArgs = {}; }
                        const t0 = Date.now();
                        const result = await executeJailedTool(call.function?.name, tArgs, projectPath);
                        appendAudit({
                            ts: new Date().toISOString(), sender, model: cfg.model,
                            task: task.slice(0, 300), tool: call.function?.name,
                            args: JSON.stringify(tArgs).slice(0, 500),
                            ok: !String(result).startsWith("Error") && !String(result).startsWith("Refused"),
                            ms: Date.now() - t0,
                        });
                        messages.push({ role: "tool", tool_call_id: call.id, content: String(result).slice(0, 8000) });
                    }
                    finalText = "";
                }
                if (!finalText) {
                    finalText = `Stopped after ${iterations} tool round(s) without a final summary. Check ${OPENCLI_LOG_FILE} for the full trace.`;
                }
            })(),
            timeout,
        ]);
    } catch (err) {
        finalText = `⚠️ @opencli stopped: ${err.message || err} (after ${iterations} round(s)). Partial work is in ${projectPath}; trace in ${OPENCLI_LOG_FILE}.`;
    }

    appendAudit({ ts: new Date().toISOString(), sender, model: cfg.model, task: task.slice(0, 300), tool: "__done__", ok: true, ms: Date.now() - started, iterations });
    return { success: true, model: cfg.model, projectPath, output: finalText, iterations };
}
