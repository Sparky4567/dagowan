import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    ensureMcpConfig,
    formatMcpStatus,
    formatMcpTools,
    isMcpEnabled,
    getMcpTimeoutMs,
    listMcpServers,
    loadMcpConfig,
    mcpResultToText,
    mcpToolName,
    mcpToolToDefinition,
    parseMcpInput,
    splitMcpToolName,
    McpManager,
    McpServerConnection,
} from "./mcp.js";

describe("mcp config helpers", () => {
    test("enabled flag accepts on/1/true", () => {
        expect(isMcpEnabled({ mcp_enabled: true })).toBe(true);
        expect(isMcpEnabled({ mcp_enabled: "on" })).toBe(true);
        expect(isMcpEnabled({ mcp_enabled: "1" })).toBe(true);
        expect(isMcpEnabled({ mcp_enabled: false })).toBe(false);
        expect(isMcpEnabled({})).toBe(false);
    });

    test("timeout falls back to default on bad input", () => {
        expect(getMcpTimeoutMs({})).toBe(15000);
        expect(getMcpTimeoutMs({ mcp_timeout_ms: 5000 })).toBe(5000);
        expect(getMcpTimeoutMs({ mcp_timeout_ms: "bad" })).toBe(15000);
    });

    test("missing config file yields empty servers", () => {
        const cfg = loadMcpConfig("/nonexistent-mcp-xyz.json");
        expect(cfg.mcpServers).toEqual({});
    });

    test("listMcpServers marks disabled entries", () => {
        const servers = listMcpServers({ mcpServers: { a: { command: "x", disabled: true }, b: { command: "y" } } });
        expect(servers.find((s) => s.name === "a")?.disabled).toBe(true);
        expect(servers.find((s) => s.name === "b")?.disabled).toBe(false);
    });
});

describe("mcp command parser", () => {
    test("parses @ and / prefixes identically", () => {
        expect(parseMcpInput("@mcp-status")).toEqual({ action: "status" });
        expect(parseMcpInput("/mcp-status")).toEqual({ action: "status" });
        expect(parseMcpInput("@mcp-tools fs")).toEqual({ action: "tools", server: "fs" });
        expect(parseMcpInput("@mcp-call fs__read {\"a\":1}")).toEqual({ action: "call", tool: "fs__read", argsJson: "{\"a\":1}" });
        expect(parseMcpInput("@mcp-reconnect fs")).toEqual({ action: "reconnect", server: "fs" });
        expect(parseMcpInput("@mcp-disable fs")).toEqual({ action: "disable", server: "fs" });
        expect(parseMcpInput("just chatting")).toBeNull();
    });
});

describe("mcp tool naming", () => {
    test("namespaces as server__tool and splits back", () => {
        expect(mcpToolName("fs", "read")).toBe("fs__read");
        expect(splitMcpToolName("fs__read")).toEqual({ server: "fs", tool: "read" });
        expect(splitMcpToolName("read_file")).toBeNull();
    });

    test("converts to Ollama function definitions", () => {
        const def = mcpToolToDefinition("fs", { name: "read", description: "Read a file", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } });
        expect(def.type).toBe("function");
        expect(def.function.name).toBe("fs__read");
        expect(def.function.parameters.properties.path).toBeTruthy();
    });

    test("result text extracts content blocks", () => {
        expect(mcpResultToText({ content: [{ type: "text", text: "hello" }] })).toBe("hello");
        expect(mcpResultToText({ content: [{ type: "text", text: "" }], isError: true })).toContain("MCP");
    });

    test("formatters render empty states", () => {
        expect(formatMcpTools([])).toContain("none");
        expect(formatMcpStatus({ enabled: false, configPath: "x", servers: [] })).toContain("none configured");
    });
});

describe("mcp manager with fake transport", () => {
    function fakeSpawn(responses) {
        return (_cmd, _args, _opts) => {
            const handlers = {};
            const child = {
                stdin: {
                    write: (line) => {
                        const msg = JSON.parse(String(line));
                        const queue = handlers["data"] || [];
                        const reply = (payload) => {
                            for (const h of queue) h(JSON.stringify(payload) + "\n");
                        };
                        if (msg.method === "initialize") {
                            reply({ jsonrpc: "2.0", id: msg.id, result: { serverInfo: { name: "fake" } } });
                        } else if (msg.method === "tools/list") {
                            reply({ jsonrpc: "2.0", id: msg.id, result: responses["tools/list"] || { tools: [] } });
                        } else if (msg.method === "tools/call") {
                            reply({ jsonrpc: "2.0", id: msg.id, result: responses["tools/call"] || { content: [{ type: "text", text: "ok" }] } });
                        }
                    },
                },
                stdout: { on: (ev, h) => { (handlers[ev] = handlers[ev] || []).push(h); } },
                stderr: { on: () => {} },
                on: () => {},
                kill: () => {},
            };
            return child;
        };
    }

    test("listTools merges namespaced definitions", async () => {
        const mgr = new McpManager({ spawnFn: fakeSpawn({ "tools/list": { tools: [{ name: "read", description: "r", inputSchema: { type: "object", properties: {} } }] } }) });
        const tools = await mgr.listTools({ mcp_enabled: true }, { config: { mcpServers: { fs: { command: "fake" } } }, force: true });
        expect(tools.map((t) => t.function.name)).toEqual(["fs__read"]);
        mgr.stopAll();
    });

    test("callTool returns text and respects disabled flag", async () => {
        const mgr = new McpManager({ spawnFn: fakeSpawn({}) });
        const out = await mgr.callTool("fs__read", {}, { mcp_enabled: true }, { config: { mcpServers: { fs: { command: "fake" } } } });
        expect(out).toBe("ok");
        const disabled = await mgr.callTool("fs__read", {}, { mcp_enabled: true }, { config: { mcpServers: { fs: { command: "fake", disabled: true } } } });
        expect(disabled).toMatch(/disabled/);
        mgr.stopAll();
    });

    test("connection surfaces rpc errors", async () => {
        const errSpawn = (_c, _a, _o) => {
            const handlers = {};
            const child = {
                stdin: { write: (line) => {
                    const msg = JSON.parse(String(line));
                    for (const h of handlers["data"] || []) h(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { message: "boom" } }) + "\n");
                } },
                stdout: { on: (ev, h) => { (handlers[ev] = handlers[ev] || []).push(h); } },
                stderr: { on: () => {} },
                on: () => {},
                kill: () => {},
            };
            return child;
        };
        const conn = new McpServerConnection("x", { command: "fake", args: [], cwd: process.cwd(), disabled: false }, {
            timeoutMs: 1000,
            spawnFn: errSpawn,
        });
        await expect(conn.rpc("tools/list")).rejects.toThrow("boom");
        conn.stop();
    });

    test("initialize handshake runs once per connection", async () => {
        let initCount = 0;
        const spawnFn = (_c, _a, _o) => {
            const handlers = {};
            const child = {
                stdin: { write: (line) => {
                    const msg = JSON.parse(String(line));
                    if (msg.method === "initialize") initCount++;
                    for (const h of handlers["data"] || []) {
                        if (msg.method === "initialize") h(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\n");
                        else if (msg.method === "tools/list") h(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [] } }) + "\n");
                        else if (msg.method === "tools/call") h(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "ok" }] } }) + "\n");
                    }
                } },
                stdout: { on: (ev, h) => { (handlers[ev] = handlers[ev] || []).push(h); } },
                stderr: { on: () => {} },
                on: () => {},
                kill: () => {},
            };
            return child;
        };
        const conn = new McpServerConnection("x", { command: "fake" }, { timeoutMs: 2000, spawnFn });
        await conn.listTools(true);
        await conn.callTool("anything", {});
        await conn.listTools(false);
        expect(initCount).toBe(1);
        conn.stop();
    });

    test("stdout log lines and CRLF do not break rpc", async () => {
        const spawnFn = (_c, _a, _o) => {
            const handlers = {};
            const child = {
                stdin: { write: (line) => {
                    const msg = JSON.parse(String(line));
                    const out = handlers["data"] || [];
                    for (const h of out) h("server starting up (log line, not JSON)\r\n");
                    for (const h of out) h(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [] } }) + "\r\n");
                } },
                stdout: { on: (ev, h) => { (handlers[ev] = handlers[ev] || []).push(h); } },
                stderr: { on: () => {} },
                on: () => {},
                kill: () => {},
            };
            return child;
        };
        const conn = new McpServerConnection("x", { command: "fake" }, { timeoutMs: 2000, spawnFn });
        const res = await conn.rpc("tools/list");
        expect(res).toEqual({ tools: [] });
        conn.stop();
    });
});

describe("mcp first-run bootstrap", () => {
    test("ensureMcpConfig creates working local server entry without overwriting", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-test-"));
        const cfgPath = path.join(dir, "mcp_servers.json");
        const settings = { mcp_config_path: cfgPath };
        const cfg = ensureMcpConfig(settings);
        expect(cfg.mcpServers.local).toBeTruthy();
        expect(cfg.mcpServers.local.command).toBeTruthy();
        // Second call must not overwrite custom content.
        cfg.mcpServers.custom = { command: "echo", args: [] };
        fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
        const cfg2 = ensureMcpConfig(settings);
        expect(cfg2.mcpServers.custom).toBeTruthy();
        expect(cfg2.mcpServers.local).toBeTruthy();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test("built-in local server answers ping/list over real stdio", async () => {
        const mgr = new McpManager();
        const settings = { mcp_enabled: true };
        const script = path.join(process.cwd(), "src", "mcp_local_server.js");
        const config = { mcpServers: { local: { command: "bun", args: [script] } } };
        const tools = await mgr.listTools(settings, { config, force: true });
        const names = tools.map((t) => t.function.name);
        expect(names).toContain("local__ping");
        expect(names).toContain("local__read_file");
        const out = await mgr.callTool("local__ping", {}, settings, { config });
        expect(out).toContain("pong");
        mgr.stopAll();
    }, 30000);
});
