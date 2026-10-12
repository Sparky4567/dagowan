// ---------------------------------------------------------------------------
// Built-in local MCP server (zero dependencies).
//
// Speaks newline-delimited JSON-RPC 2.0 over stdio:
//   initialize -> tools/list -> tools/call
// Run: `bun src/mcp_local_server.js` (or `node src/mcp_local_server.js`).
//
// Safe by default: read-only tools (ping / read_file / list_directory),
// paths resolved against process.cwd(), `..` escapes rejected.
// This is the server auto-registered by ensureMcpConfig() so MCP
// "just works" on a fresh checkout without network access.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";

const TOOLS = [
    {
        name: "ping",
        description: "Health check — replies with pong and the server pid/cwd.",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "read_file",
        description: "Read a text file relative to the server working directory.",
        inputSchema: {
            type: "object",
            properties: {
                file_path: { type: "string", description: "Relative or absolute file path." },
                max_chars: { type: "integer", description: "Max characters to return (default 8000)." },
            },
            required: ["file_path"],
        },
    },
    {
        name: "list_directory",
        description: "List files in a directory relative to the server working directory.",
        inputSchema: {
            type: "object",
            properties: {
                directory_path: { type: "string", description: "Directory to list (default '.')." },
            },
        },
    },
];

function resolveSafe(targetPath, root = process.cwd()) {
    const base = path.resolve(root);
    if (!targetPath || targetPath === ".") return base;
    const abs = path.isAbsolute(targetPath) ? path.resolve(targetPath) : path.resolve(base, targetPath);
    const rel = path.relative(base, abs);
    if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return abs;
    return null;
}

function textResult(text) {
    return { content: [{ type: "text", text: String(text) }] };
}

async function handleCall(name, args = {}) {
    if (name === "ping") {
        return textResult(`pong (pid=${process.pid} cwd=${process.cwd()})`);
    }
    if (name === "read_file") {
        const fp = args.file_path || args.path || "";
        if (!fp) return { content: [{ type: "text", text: "file_path is required" }], isError: true };
        const safe = resolveSafe(String(fp));
        if (!safe) return { content: [{ type: "text", text: `Refused: path escapes working directory: ${fp}` }], isError: true };
        try {
            const stat = await fs.promises.stat(safe);
            if (stat.isDirectory()) return { content: [{ type: "text", text: `Not a file (is a directory): ${fp}` }], isError: true };
            const max = Number(args.max_chars) > 0 ? Math.min(Number(args.max_chars), 100000) : 8000;
            const text = await fs.promises.readFile(safe, "utf8");
            return textResult(text.length > max ? text.slice(0, max) + `\n…(truncated ${text.length - max} chars)` : text);
        } catch (err) {
            return { content: [{ type: "text", text: `read_file failed: ${err.message || err}` }], isError: true };
        }
    }
    if (name === "list_directory") {
        const dp = args.directory_path || args.path || ".";
        const safe = resolveSafe(String(dp));
        if (!safe) return { content: [{ type: "text", text: `Refused: path escapes working directory: ${dp}` }], isError: true };
        try {
            const entries = await fs.promises.readdir(safe, { withFileTypes: true });
            const lines = await Promise.all(entries.map(async (e) => {
                if (e.isDirectory()) return `[DIR]  ${e.name}/`;
                try {
                    const st = await fs.promises.stat(path.join(safe, e.name));
                    return `[FILE] ${e.name} (${st.size} bytes)`;
                } catch { return `[FILE] ${e.name}`; }
            }));
            return textResult(lines.length === 0 ? `(empty: ${dp})` : lines.join("\n"));
        } catch (err) {
            return { content: [{ type: "text", text: `list_directory failed: ${err.message || err}` }], isError: true };
        }
    }
    return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
}

function reply(id, result) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function replyError(id, message) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: String(message) } }) + "\n");
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
    buffer += String(chunk);
    let idx;
    while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        (async () => {
            try {
                if (msg.method === "initialize") {
                    reply(msg.id, {
                        protocolVersion: "2024-11-05",
                        capabilities: { tools: {} },
                        serverInfo: { name: "dagowan-local", version: "1.0.0" },
                    });
                } else if (msg.method === "tools/list") {
                    reply(msg.id, { tools: TOOLS });
                } else if (msg.method === "tools/call") {
                    const params = msg.params || {};
                    reply(msg.id, await handleCall(params.name, params.arguments || {}));
                } else if (typeof msg.id !== "undefined" && msg.id !== null) {
                    replyError(msg.id, `Unknown method: ${msg.method}`);
                }
                // Notifications (no id, e.g. notifications/initialized): ignore.
            } catch (err) {
                if (typeof msg.id !== "undefined" && msg.id !== null) replyError(msg.id, err.message || err);
            }
        })();
    }
});
