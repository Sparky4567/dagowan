// ---------------------------------------------------------------------------
// Dagowan MCP SERVER (stdio + HTTP/SSE) — expose the assistant to other
// MCP-capable clients (including web-based chat assistants).
//
// Run:
//   bun run index.js --mcp            # HTTP server (default) + stdio JSON-RPC
//   MCP_PORT=8790 MCP_TOKEN=secret bun run index.js --mcp
//
// HTTP endpoints:
//   POST /mcp            Streamable HTTP (JSON-RPC request/response)
//   GET  /sse            Legacy SSE transport (endpoint event -> /messages)
//   POST /messages       Legacy SSE message ingress
//   GET  /health         Health check
//
// Stdio: newline-delimited JSON-RPC 2.0 on stdin/stdout (for local clients).
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import { loadSettings, saveSettings } from "./config.js";
import { loadCharacterStore, getActiveCharacter } from "./characters.js";
import { DashboardServer } from "./dashboard.js";
import { listSessions, loadSession, createSession } from "./sessions.js";
import { retrieveMemories, remember, loadMemories } from "./memory.js";
import { getAllTasks, registerTask } from "./tasks.js";
import { searchWeb, fetchPageText, formatWebResults, formatPageText } from "./websearch.js";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_NAME = "dagowan";
const SERVER_VERSION = "1.0.0";

function logErr(...args) {
    try { console.error(...args); } catch {}
}

function textResult(text) {
    return { content: [{ type: "text", text: String(text ?? "") }] };
}

function jsonRpc(id, result) {
    return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id, code, message) {
    return { jsonrpc: "2.0", id, error: { code, message: String(message) } };
}

export const TOOLS = [
    {
        name: "ping",
        description: "Health check for the Dagowan MCP server.",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "dagowan_chat",
        description: "Send a message to the Dagowan assistant and get a reply. Supports @ commands, memory, tasks, web search, etc.",
        inputSchema: {
            type: "object",
            properties: {
                message: { type: "string", description: "User message or @ command." },
                sessionId: { type: "string", description: "Optional existing session id." },
                characterId: { type: "string", description: "Optional character id." },
            },
            required: ["message"],
        },
    },
    {
        name: "list_sessions",
        description: "List chat sessions for a character.",
        inputSchema: {
            type: "object",
            properties: {
                characterId: { type: "string", description: "Character id (default active)." },
            },
        },
    },
    {
        name: "get_memories",
        description: "Retrieve relevant memories for a query.",
        inputSchema: {
            type: "object",
            properties: {
                query: { type: "string", description: "Search query." },
                limit: { type: "integer", description: "Max results (default 10)." },
                characterId: { type: "string", description: "Character id (default active)." },
            },
        },
    },
    {
        name: "remember",
        description: "Store a new memory.",
        inputSchema: {
            type: "object",
            properties: {
                text: { type: "string", description: "Memory text." },
                characterId: { type: "string", description: "Character id (default active)." },
            },
            required: ["text"],
        },
    },
    {
        name: "list_tasks",
        description: "List all tasks.",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "add_task",
        description: "Add a new task.",
        inputSchema: {
            type: "object",
            properties: {
                text: { type: "string", description: "Task text." },
                status: { type: "string", description: "Status code (default 'p')." },
            },
            required: ["text"],
        },
    },
    {
        name: "web_search",
        description: "Search the web and return formatted results.",
        inputSchema: {
            type: "object",
            properties: {
                query: { type: "string", description: "Search query." },
                limit: { type: "integer", description: "Max results." },
                provider: { type: "string", description: "auto|duckduckgo|brave|tavily|google-ai" },
            },
            required: ["query"],
        },
    },
    {
        name: "web_fetch",
        description: "Fetch a URL and return its text content.",
        inputSchema: {
            type: "object",
            properties: {
                url: { type: "string", description: "URL to fetch." },
            },
            required: ["url"],
        },
    },
];

export class McpServerState {
    constructor(settings, characterStore) {
        this.settings = settings || loadSettings();
        this.characterStore = characterStore || loadCharacterStore(
            "characters.json",
            this.settings.model,
            this.settings.system_template
        );
        this.dashboard = new DashboardServer({ settings: this.settings, characterStore: this.characterStore });
    }

    get activeCharacter() {
        try { return getActiveCharacter(this.characterStore); } catch {
            return { id: this.settings.active_character || "main", name: "Main" };
        }
    }

    async handleTool(name, args = {}) {
        args = args || {};
        switch (name) {
            case "ping":
                return textResult(`pong (server=${SERVER_NAME} pid=${process.pid} cwd=${process.cwd()})`);
            case "dagowan_chat": {
                const msg = String(args.message || "").trim();
                if (!msg) return { content: [{ type: "text", text: "message is required" }], isError: true };
                const res = await this.dashboard.handleChat({
                    message: msg,
                    sessionId: args.sessionId || null,
                    characterId: args.characterId || null,
                });
                const reply = res && (res.reply || res.message || "");
                let out = String(reply || "");
                if (res && res.sessionId) out += `\n\n[session: ${res.sessionId}]`;
                return textResult(out);
            }
            case "list_sessions": {
                const cid = args.characterId || this.activeCharacter.id;
                const sessions = listSessions(cid);
                return textResult(JSON.stringify(sessions, null, 2));
            }
            case "get_memories": {
                const q = String(args.query || "").trim();
                const limit = Number(args.limit) > 0 ? Number(args.limit) : 10;
                const cid = args.characterId || this.activeCharacter.id;
                const mems = retrieveMemories(q, limit, undefined, cid);
                return textResult(JSON.stringify(mems, null, 2));
            }
            case "remember": {
                const text = String(args.text || "").trim();
                if (!text) return { content: [{ type: "text", text: "text is required" }], isError: true };
                const cid = args.characterId || this.activeCharacter.id;
                const mem = remember(text, undefined, cid);
                return textResult(JSON.stringify(mem, null, 2));
            }
            case "list_tasks": {
                const tasks = getAllTasks();
                return textResult(JSON.stringify(tasks, null, 2));
            }
            case "add_task": {
                const text = String(args.text || "").trim();
                if (!text) return { content: [{ type: "text", text: "text is required" }], isError: true };
                const status = args.status || "p";
                const task = registerTask(text, status);
                return textResult(JSON.stringify(task, null, 2));
            }
            case "web_search": {
                const query = String(args.query || "").trim();
                if (!query) return { content: [{ type: "text", text: "query is required" }], isError: true };
                const limit = Number(args.limit) > 0 ? Number(args.limit) : undefined;
                const res = await searchWeb(query, this.settings, { limit, provider: args.provider });
                return textResult(formatWebResults(res));
            }
            case "web_fetch": {
                const url = String(args.url || "").trim();
                if (!url) return { content: [{ type: "text", text: "url is required" }], isError: true };
                const res = await fetchPageText(url, this.settings);
                return textResult(formatPageText(res));
            }
            default:
                return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
        }
    }

    async handleRpc(msg) {
        if (!msg || typeof msg !== "object") {
            return jsonRpcError(null, -32600, "Invalid request");
        }
        const { id, method, params } = msg;
        try {
            if (method === "initialize") {
                return jsonRpc(id, {
                    protocolVersion: PROTOCOL_VERSION,
                    capabilities: { tools: {} },
                    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
                });
            }
            if (method === "notifications/initialized" || method === "initialized") {
                if (id === undefined || id === null) return null;
                return jsonRpc(id, {});
            }
            if (method === "ping") {
                return jsonRpc(id, {});
            }
            if (method === "tools/list") {
                return jsonRpc(id, { tools: TOOLS });
            }
            if (method === "tools/call") {
                const p = params || {};
                const result = await this.handleTool(p.name, p.arguments || {});
                return jsonRpc(id, result);
            }
            if (method === "resources/list") {
                return jsonRpc(id, { resources: [] });
            }
            if (method === "prompts/list") {
                return jsonRpc(id, { prompts: [] });
            }
            if (id === undefined || id === null) return null;
            return jsonRpcError(id, -32601, `Method not found: ${method}`);
        } catch (err) {
            if (id === undefined || id === null) return null;
            return jsonRpcError(id, -32000, err && err.message ? err.message : String(err));
        }
    }
}

// ---------------------------------------------------------------------------
// HTTP transport
// ---------------------------------------------------------------------------

function getToken(settings) {
    return process.env.MCP_TOKEN || (settings && settings.mcp_server_token) || "";
}

function isLoopback(req) {
    try {
        const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "";
        // Bun's server doesn't expose remoteAddress easily on Request; fall back to allowing.
        return true;
    } catch { return true; }
}

function checkAuth(req, settings) {
    const token = getToken(settings);
    if (!token) return true;
    const auth = req.headers.get("authorization") || "";
    if (auth === `Bearer ${token}`) return true;
    return false;
}

export async function startHttpServer(state, port) {
    const sessions = new Map(); // sessionId -> { stream: WritableStreamDefaultWriter, encoder }
    let sessionCounter = 0;

    const server = Bun.serve({
        port,
        hostname: "0.0.0.0",
        async fetch(req) {
            const url = new URL(req.url);
            const pathname = url.pathname;

            if (pathname === "/health" || pathname === "/api/health") {
                return new Response(JSON.stringify({ ok: true, service: "dagowan-mcp", tools: TOOLS.length }), {
                    headers: { "Content-Type": "application/json" },
                });
            }

            if (!checkAuth(req, state.settings)) {
                return new Response(JSON.stringify({ error: "Unauthorized" }), {
                    status: 401,
                    headers: { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" },
                });
            }

            // Streamable HTTP
            if (pathname === "/mcp") {
                if (req.method === "POST") {
                    let body;
                    try { body = await req.json(); } catch {
                        return new Response(JSON.stringify(jsonRpcError(null, -32700, "Parse error")), {
                            status: 400,
                            headers: { "Content-Type": "application/json" },
                        });
                    }
                    const isBatch = Array.isArray(body);
                    const items = isBatch ? body : [body];
                    const results = [];
                    for (const item of items) {
                        const r = await state.handleRpc(item);
                        if (r !== null) results.push(r);
                    }
                    if (results.length === 0) {
                        return new Response(null, { status: 202 });
                    }
                    const payload = isBatch ? results : results[0];
                    return new Response(JSON.stringify(payload), {
                        headers: { "Content-Type": "application/json" },
                    });
                }
                if (req.method === "GET") {
                    // Minimal SSE stream for server->client messages (none produced here).
                    const stream = new ReadableStream({
                        start(controller) {
                            const encoder = new TextEncoder();
                            const ping = setInterval(() => {
                                try { controller.enqueue(encoder.encode(": ping\n\n")); } catch {}
                            }, 15000);
                            req.signal.addEventListener("abort", () => {
                                clearInterval(ping);
                                try { controller.close(); } catch {}
                            });
                        },
                    });
                    return new Response(stream, {
                        headers: {
                            "Content-Type": "text/event-stream",
                            "Cache-Control": "no-cache",
                            "Connection": "keep-alive",
                        },
                    });
                }
                return new Response("Method Not Allowed", { status: 405 });
            }

            // Legacy SSE transport
            if (pathname === "/sse" && req.method === "GET") {
                const sessionId = `s${++sessionCounter}`;
                const encoder = new TextEncoder();
                let controllerRef = null;
                const stream = new ReadableStream({
                    start(controller) {
                        controllerRef = controller;
                        const msg = `event: endpoint\ndata: /messages?sessionId=${sessionId}\n\n`;
                        controller.enqueue(encoder.encode(msg));
                    },
                });
                sessions.set(sessionId, { controller: controllerRef, encoder });
                // store controller lazily
                const entry = sessions.get(sessionId);
                // ensure controller reference updated
                const interval = setInterval(() => {
                    try { entry.controller.enqueue(encoder.encode(": ping\n\n")); } catch {}
                }, 15000);
                req.signal.addEventListener("abort", () => {
                    clearInterval(interval);
                    sessions.delete(sessionId);
                    try { controllerRef.close(); } catch {}
                });
                return new Response(stream, {
                    headers: {
                        "Content-Type": "text/event-stream",
                        "Cache-Control": "no-cache",
                        "Connection": "keep-alive",
                    },
                });
            }

            if (pathname === "/messages" && req.method === "POST") {
                const sessionId = url.searchParams.get("sessionId");
                const entry = sessions.get(sessionId);
                if (!entry) {
                    return new Response(JSON.stringify(jsonRpcError(null, -32000, "Unknown session")), {
                        status: 404,
                        headers: { "Content-Type": "application/json" },
                    });
                }
                let body;
                try { body = await req.json(); } catch {
                    return new Response("Parse error", { status: 400 });
                }
                const items = Array.isArray(body) ? body : [body];
                for (const item of items) {
                    const r = await state.handleRpc(item);
                    if (r !== null) {
                        const payload = `event: message\ndata: ${JSON.stringify(r)}\n\n`;
                        try { entry.controller.enqueue(entry.encoder.encode(payload)); } catch {}
                    }
                }
                return new Response("Accepted", { status: 202 });
            }

            return new Response("Not Found", { status: 404 });
        },
    });

    logErr(`[mcp] HTTP server listening on http://0.0.0.0:${port}`);
    logErr(`[mcp] Streamable HTTP endpoint: http://0.0.0.0:${port}/mcp`);
    logErr(`[mcp] Legacy SSE endpoint: http://0.0.0.0:${port}/sse`);
    if (getToken(state.settings)) logErr("[mcp] Bearer token auth ENABLED");
    else logErr("[mcp] WARNING: no MCP_TOKEN set — unauthenticated (set MCP_TOKEN or settings.mcp_server_token)");
    return server;
}

// ---------------------------------------------------------------------------
// Stdio transport
// ---------------------------------------------------------------------------

export async function startStdioServer(state) {
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
                    const r = await state.handleRpc(msg);
                    if (r !== null) {
                        process.stdout.write(JSON.stringify(r) + "\n");
                    }
                } catch (err) {
                    process.stdout.write(JSON.stringify(jsonRpcError(msg && msg.id, -32000, err && err.message ? err.message : String(err))) + "\n");
                }
            })();
        }
    });
    process.stdin.on("end", () => {
        // keep process alive for HTTP if running; otherwise exit
    });
    logErr("[mcp] stdio JSON-RPC ready");
}

export async function startMcpServer(opts = {}) {
    const settings = opts.settings || loadSettings();
    const characterStore = opts.characterStore || loadCharacterStore(
        "characters.json",
        settings.model,
        settings.system_template
    );
    const state = new McpServerState(settings, characterStore);

    const http = opts.http !== false;
    const stdio = opts.stdio !== false;

    if (http) {
        const port = Number(opts.port || process.env.MCP_PORT || settings.mcp_server_port || 8790);
        await startHttpServer(state, port);
    }
    if (stdio) {
        await startStdioServer(state);
    }

    // Keep process alive
    if (!stdio && http) {
        // HTTP server keeps event loop alive
    }
    return state;
}
