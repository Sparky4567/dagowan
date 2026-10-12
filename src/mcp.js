// ---------------------------------------------------------------------------
// MCP (Model Context Protocol) client — stdio JSON-RPC, no external deps.
//
// Speaks the MCP stdio framing (newline-delimited JSON-RPC 2.0):
//   initialize -> notifications/initialized -> tools/list -> tools/call
// Compatible with `mcp_servers.json` in Claude-desktop format:
//   { "mcpServers": { "fs": { "command": "npx", "args": [...], "env": {...}, "disabled": false } } }
//
// Design notes (match repo conventions in needle.js / browser.js):
//   - Pure parsers/formatters are dependency-free and unit-tested.
//   - Process spawning goes through an injectable `spawnFn` so
//     `bun test` never launches real servers.
//   - Tool names are namespaced as `server__tool` to avoid collisions
//     with built-in tools in ollama_cli/src/tools.ts.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

export const MCP_DEFAULT_CONFIG_PATH = "mcp_servers.json";
export const MCP_DEFAULT_TIMEOUT_MS = 15000;
export const MCP_PROTOCOL_VERSION = "2024-11-05";
export const MCP_CLIENT_NAME = "dagowan";
export const MCP_CLIENT_VERSION = "1.0.0";

// --- settings ---------------------------------------------------------------

export function getMcpConfigPath(settings = {}) {
    return (
        (settings && settings.mcp_config_path) ||
        process.env.MCP_CONFIG_PATH ||
        MCP_DEFAULT_CONFIG_PATH
    );
}

export function isMcpEnabled(settings = {}) {
    const v = (settings && settings.mcp_enabled) ?? process.env.MCP_ENABLED ?? false;
    if (typeof v === "boolean") return v;
    return ["1", "true", "on", "yes", "enable", "enabled"].includes(String(v).trim().toLowerCase());
}

export function getMcpTimeoutMs(settings = {}) {
    const raw = (settings && settings.mcp_timeout_ms) ?? process.env.MCP_TIMEOUT_MS ?? MCP_DEFAULT_TIMEOUT_MS;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return MCP_DEFAULT_TIMEOUT_MS;
    return Math.min(n, 120000);
}

// --- config file ------------------------------------------------------------

export function loadMcpConfig(configPath = MCP_DEFAULT_CONFIG_PATH) {
    const resolved = path.isAbsolute(configPath) ? configPath : path.join(process.cwd(), configPath);
    if (!fs.existsSync(resolved)) return { path: resolved, mcpServers: {} };
    try {
        const raw = fs.readFileSync(resolved, "utf8");
        const data = JSON.parse(raw);
        const servers = (data && (data.mcpServers || data.mcp_servers || data.servers)) || {};
        if (typeof servers !== "object" || Array.isArray(servers)) {
            return { path: resolved, mcpServers: {} };
        }
        return { path: resolved, mcpServers: servers };
    } catch {
        return { path: resolved, mcpServers: {} };
    }
}

export function saveMcpConfig(config, configPath = MCP_DEFAULT_CONFIG_PATH) {
    const resolved = path.isAbsolute(configPath) ? configPath : path.join(process.cwd(), configPath);
    const payload = { mcpServers: (config && config.mcpServers) || {} };
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    const tmp = `${resolved}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
    fs.renameSync(tmp, resolved);
    return resolved;
}

export function listMcpServers(config) {
    const servers = (config && config.mcpServers) || {};
    return Object.entries(servers).map(([name, def]) => ({
        name,
        command: (def && def.command) || "",
        args: Array.isArray(def && def.args) ? def.args : [],
        env: (def && def.env) || {},
        cwd: (def && (def.cwd || def.working_directory)) || process.cwd(),
        disabled: Boolean(def && (def.disabled === true || def.enabled === false)),
        raw: def || {},
    }));
}

// --- first-run bootstrap ----------------------------------------------------
// Creates mcp_servers.json with the zero-dependency built-in `local` server
// (src/mcp_local_server.js via bun/node) so MCP works on a fresh checkout
// without network access. Never overwrites an existing file.

export function defaultLocalServerEntry() {
    const serverScript = path.join(process.cwd(), "src", "mcp_local_server.js");
    const bunBin = typeof process !== "undefined" && process.execPath && process.execPath.includes("bun")
        ? process.execPath
        : "bun";
    return { command: bunBin, args: [serverScript], env: {} };
}

export function defaultWebServerEntry() {
    const serverScript = path.join(process.cwd(), "src", "mcp_web_server.js");
    const bunBin = typeof process !== "undefined" && process.execPath && process.execPath.includes("bun")
        ? process.execPath
        : "bun";
    return { command: bunBin, args: [serverScript], env: {} };
}

export function ensureMcpConfig(settings = {}) {
    const configPath = getMcpConfigPath(settings);
    const resolved = path.isAbsolute(configPath) ? configPath : path.join(process.cwd(), configPath);
    if (fs.existsSync(resolved)) {
        // Migrate: add the zero-dependency `web` (live search) server next
        // to `local` on existing installs without touching custom entries.
        try {
            const existing = loadMcpConfig(resolved);
            if (existing && existing.mcpServers && !existing.mcpServers.web) {
                existing.mcpServers.web = defaultWebServerEntry();
                try { saveMcpConfig(existing, resolved); } catch {}
            }
            return loadMcpConfig(resolved);
        } catch {
            return loadMcpConfig(resolved);
        }
    }
    const cfg = {
        path: resolved,
        mcpServers: {
            local: defaultLocalServerEntry(),
            web: defaultWebServerEntry(),
        },
    };
    try {
        saveMcpConfig(cfg, resolved);
    } catch {}
    return cfg;
}

// --- command parsing --------------------------------------------------------
// Shared "@mcp ..." parser so CLI / Telegram / WhatsApp behave identically.

export function parseMcpInput(text) {
    const rawInput = String(text || "").trim();
    const norm = rawInput.startsWith("@") ? "/" + rawInput.slice(1) : rawInput;
    const low = norm.toLowerCase();
    const head = low.split(/\s/, 1)[0];

    if (head === "/mcp-status" || head === "/mcp") return { action: "status" };
    if (head === "/mcp-list" || head === "/mcp-servers") return { action: "list" };
    if (head === "/mcp-tools") {
        const server = norm.slice(head.length).trim();
        return { action: "tools", server: server || "" };
    }
    if (head === "/mcp-reconnect") {
        const server = norm.slice(head.length).trim();
        return { action: "reconnect", server };
    }
    if (head === "/mcp-call") {
        const payload = norm.slice(head.length).trim();
        const sp = payload.indexOf(" ");
        if (sp === -1) return { action: "call", tool: payload, argsJson: "" };
        return { action: "call", tool: payload.slice(0, sp).trim(), argsJson: payload.slice(sp + 1).trim() };
    }
    if (head === "/mcp-enable" || head === "/mcp-disable") {
        const server = norm.slice(head.length).trim();
        return { action: head === "/mcp-enable" ? "enable" : "disable", server };
    }
    return null;
}

// --- tool conversion --------------------------------------------------------

export function mcpToolName(serverName, toolName) {
    return `${serverName}__${toolName}`;
}

export function splitMcpToolName(fullName) {
    const s = String(fullName || "");
    const idx = s.indexOf("__");
    if (idx === -1) return null;
    return { server: s.slice(0, idx), tool: s.slice(idx + 2) };
}

export function mcpToolToDefinition(serverName, tool) {
    const name = mcpToolName(serverName, (tool && tool.name) || "unknown");
    const description = (tool && (tool.description || tool.title)) || `MCP tool ${name}`;
    let parameters = (tool && (tool.inputSchema || tool.input_schema || tool.parameters)) || { type: "object", properties: {} };
    if (parameters.type !== "object") {
        parameters = { type: "object", properties: { input: parameters } };
    }
    if (!parameters.properties || typeof parameters.properties !== "object") {
        parameters = { type: "object", properties: {} };
    }
    return { type: "function", function: { name, description: String(description).slice(0, 1000), parameters } };
}

export function formatMcpStatus(status) {
    const lines = ["🔌 MCP (Model Context Protocol):"];
    lines.push(`  • Enabled: ${status.enabled ? "yes" : "no"} (@set-setting mcp_enabled <on|off>)`);
    lines.push(`  • Config: ${status.configPath}`);
    if (!status.servers || status.servers.length === 0) {
        lines.push("  • Servers: none configured (see mcp_servers.example.json)");
        return lines.join("\n");
    }
    for (const s of status.servers) {
        const state = s.disabled ? "disabled" : (s.connected ? `connected (${s.toolCount} tools)` : (s.error ? `error: ${s.error}` : "not connected"));
        lines.push(`  • ${s.name}: ${state}`);
    }
    return lines.join("\n");
}

export function formatMcpTools(tools) {
    if (!tools || tools.length === 0) return "🔌 MCP tools: none (connect a server first, then @mcp-tools).";
    const lines = [`🔌 MCP tools (${tools.length}):`];
    for (const t of tools) {
        lines.push(`  • ${t.function.name} — ${(t.function.description || "").slice(0, 120)}`);
    }
    return lines.join("\n");
}

// --- stdio JSON-RPC connection ----------------------------------------------

function defaultSpawnFn(command, args, opts) {
    return spawn(command, args, { ...opts, stdio: ["pipe", "pipe", "pipe"] });
}

export class McpServerConnection {
    constructor(name, def, opts = {}) {
        this.name = name;
        this.def = def;
        this.timeoutMs = opts.timeoutMs || MCP_DEFAULT_TIMEOUT_MS;
        this.spawnFn = opts.spawnFn || defaultSpawnFn;
        this.child = null;
        this.nextId = 1;
        this.pending = new Map();
        this.buffer = "";
        this.toolsCache = null;
        this.lastError = null;
        this.initialized = false;
    }

    get connected() {
        return Boolean(this.child);
    }

    ensure() {
        if (this.child) return this.child;
        const cmd = this.def.command;
        if (!cmd) throw new Error(`MCP server "${this.name}" has no command`);
        const child = this.spawnFn(cmd, this.def.args || [], {
            cwd: this.def.cwd || process.cwd(),
            env: { ...process.env, ...(this.def.env || {}) },
        });
        if (!child || !child.stdin || !child.stdout) {
            throw new Error(`MCP server "${this.name}" failed to spawn`);
        }
        this.child = child;
        this.buffer = "";
        try {
            child.stdout.on("data", (d) => this._onData(String(d)));
            child.stderr.on("data", () => {});
            child.on("error", (e) => this._onClose(e.message || String(e)));
            child.on("close", () => this._onClose(null));
        } catch (e) {
            this._onClose(e.message || String(e));
            throw e;
        }
        return child;
    }

    _onData(chunk) {
        // Newline-delimited JSON-RPC. Tolerate \r\n, several messages per
        // chunk, and non-JSON log lines on stdout (skipped, pending kept).
        this.buffer += String(chunk);
        let idx;
        while ((idx = this.buffer.indexOf("\n")) !== -1) {
            const rawLine = this.buffer.slice(0, idx);
            this.buffer = this.buffer.slice(idx + 1);
            const line = rawLine.trim();
            if (!line) continue;
            let msg;
            try { msg = JSON.parse(line); } catch { continue; }
            if (msg.id === undefined || msg.id === null) continue; // notification, ignore
            const entry = this.pending.get(msg.id);
            if (entry) {
                this.pending.delete(msg.id);
                clearTimeout(entry.timer);
                if (msg.error) entry.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
                else entry.resolve(msg.result);
            }
        }
        // Safety valve: a server spewing non-newline garbage must not grow
        // the buffer without bound while requests hang until timeout.
        if (this.buffer.length > 1024 * 1024) {
            this.buffer = this.buffer.slice(-256 * 1024);
        }
    }

    _onClose(err) {
        const queued = [...this.pending.values()];
        this.pending.clear();
        this.child = null;
        this.toolsCache = null;
        this.initialized = false;
        if (err) this.lastError = err;
        for (const { reject } of queued) reject(new Error(err || `MCP server "${this.name}" exited`));
    }

    rpc(method, params = {}) {
        const child = this.ensure();
        const id = this.nextId++;
        const payload = { jsonrpc: "2.0", id, method, params };
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`MCP "${method}" timed out after ${this.timeoutMs}ms`));
            }, this.timeoutMs);
            if (timer.unref) timer.unref();
            this.pending.set(id, { resolve, reject, timer });
            try {
                child.stdin.write(JSON.stringify(payload) + "\n");
            } catch (e) {
                this.pending.delete(id);
                clearTimeout(timer);
                reject(e);
            }
        });
    }

    async initialize() {
        // Handshake once per process — many servers reject a second
        // `initialize` on the same stdio channel.
        if (this.initialized) return { already: true };
        const result = await this.rpc("initialize", {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: MCP_CLIENT_NAME, version: MCP_CLIENT_VERSION },
        });
        try {
            const child = this.ensure();
            child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
        } catch {}
        this.initialized = true;
        return result;
    }

    async listTools(force = false) {
        if (this.toolsCache && !force) return this.toolsCache;
        await this.initialize();
        const result = await this.rpc("tools/list", {});
        const tools = Array.isArray(result && result.tools) ? result.tools : [];
        this.toolsCache = tools;
        this.lastError = null;
        return tools;
    }

    async callTool(toolName, args = {}) {
        await this.initialize();
        const result = await this.rpc("tools/call", { name: toolName, arguments: args || {} });
        return result;
    }

    stop() {
        const queued = [...this.pending.values()];
        this.pending.clear();
        const proc = this.child;
        this.child = null;
        this.toolsCache = null;
        this.initialized = false;
        for (const { reject } of queued) reject(new Error("MCP connection stopped"));
        try { if (proc) proc.kill("SIGKILL"); } catch {}
    }
}

export function mcpResultToText(result) {
    if (result === null || result === undefined) return "MCP tool returned no content.";
    if (typeof result === "string") return result;
    const content = result.content;
    if (Array.isArray(content)) {
        const parts = content.map((c) => {
            if (typeof c === "string") return c;
            if (c && typeof c.text === "string") return c.text;
            if (c && c.data) return `[${c.mimeType || c.type || "data"}: ${String(c.data).slice(0, 500)}]`;
            return JSON.stringify(c);
        });
        const text = parts.join("\n").trim();
        if (text) return text.slice(0, 8000);
    }
    if (result.isError) return `MCP tool error: ${JSON.stringify(result).slice(0, 2000)}`;
    return JSON.stringify(result, null, 2).slice(0, 8000);
}

// --- manager singleton ------------------------------------------------------

let sharedManager = null;

export class McpManager {
    constructor(opts = {}) {
        this.connections = new Map();
        this.spawnFn = opts.spawnFn || null;
    }

    _connFor(server, settings = {}) {
        const key = `${server.name}`;
        if (!this.connections.has(key)) {
            this.connections.set(key, new McpServerConnection(server.name, server, {
                timeoutMs: getMcpTimeoutMs(settings),
                spawnFn: this.spawnFn || defaultSpawnFn,
            }));
        }
        return this.connections.get(key);
    }

    getConfig(settings = {}, opts = {}) {
        if (opts.ensure === true) return ensureMcpConfig(settings);
        return loadMcpConfig(getMcpConfigPath(settings));
    }

    async getStatus(settings = {}) {
        const enabled = isMcpEnabled(settings);
        const cfg = ensureMcpConfig(settings);
        const servers = listMcpServers(cfg);
        const out = [];
        for (const s of servers) {
            const conn = this.connections.get(s.name);
            out.push({
                name: s.name,
                command: s.command,
                disabled: s.disabled,
                connected: Boolean(conn && conn.connected),
                toolCount: conn && conn.toolsCache ? conn.toolsCache.length : 0,
                error: conn ? (conn.lastError || "") : "",
            });
        }
        return { enabled, configPath: cfg.path, servers: out };
    }

    async listTools(settings = {}, opts = {}) {
        if (!isMcpEnabled(settings)) return [];
        const cfg = opts.config || ensureMcpConfig(settings);
        const servers = listMcpServers(cfg).filter((s) => !s.disabled && s.command);
        const defs = [];
        const spawnFn = opts.spawnFn || this.spawnFn || null;
        for (const s of servers) {
            try {
                if (spawnFn && !this.connections.has(s.name)) {
                    this.connections.set(s.name, new McpServerConnection(s.name, s, {
                        timeoutMs: getMcpTimeoutMs(settings),
                        spawnFn,
                    }));
                }
                const conn = this._connFor(s, settings);
                if (spawnFn) conn.spawnFn = spawnFn;
                const tools = await conn.listTools(opts.force === true);
                for (const t of tools) defs.push(mcpToolToDefinition(s.name, t));
            } catch (e) {
                const conn = this.connections.get(s.name);
                if (conn) conn.lastError = e.message || String(e);
            }
        }
        return defs;
    }

    isMcpTool(name) {
        return splitMcpToolName(name) !== null;
    }

    async callTool(fullName, args = {}, settings = {}, opts = {}) {
        const split = splitMcpToolName(fullName);
        if (!split) return `Error: Unknown tool '${fullName}'.`;
        if (!isMcpEnabled(settings)) return `MCP is disabled (@set-setting mcp_enabled on).`;
        const cfg = opts.config || ensureMcpConfig(settings);
        const servers = listMcpServers(cfg);
        const server = servers.find((s) => s.name === split.server);
        if (!server) return `Error: MCP server '${split.server}' not found.`;
        if (server.disabled) return `Error: MCP server '${split.server}' is disabled.`;
        try {
            const spawnFn = opts.spawnFn || this.spawnFn || null;
            if (spawnFn && !this.connections.has(server.name)) {
                this.connections.set(server.name, new McpServerConnection(server.name, server, {
                    timeoutMs: getMcpTimeoutMs(settings),
                    spawnFn,
                }));
            }
            const conn = this._connFor(server, settings);
            if (spawnFn) conn.spawnFn = spawnFn;
            const result = await conn.callTool(split.tool, args);
            return mcpResultToText(result);
        } catch (e) {
            return `MCP tool '${fullName}' failed: ${e.message || e}`;
        }
    }

    async reconnect(serverName = "", settings = {}) {
        if (serverName) {
            const conn = this.connections.get(serverName);
            if (conn) { conn.stop(); this.connections.delete(serverName); }
            return [`Reconnected "${serverName}" (lazy — next use re-spawns).`];
        }
        for (const [, conn] of this.connections) { try { conn.stop(); } catch {} }
        this.connections.clear();
        return ["All MCP connections closed (lazy — next use re-spawns)."];
    }

    stopAll() {
        for (const [, conn] of this.connections) { try { conn.stop(); } catch {} }
        this.connections.clear();
    }
}

export function getMcpManager(opts = {}) {
    if (!sharedManager) sharedManager = new McpManager(opts);
    if (opts.spawnFn) sharedManager.spawnFn = opts.spawnFn;
    return sharedManager;
}

export function stopMcpManager() {
    try { if (sharedManager) sharedManager.stopAll(); } catch {}
    sharedManager = null;
}
