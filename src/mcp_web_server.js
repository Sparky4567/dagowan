// ---------------------------------------------------------------------------
// MCP `web` server — live web search + page fetch over stdio.
//
// Zero-dependency stdio JSON-RPC server (same framing as mcp_local_server.js):
//   initialize -> tools/list -> tools/call
// Run: `bun src/mcp_web_server.js` (or `node src/mcp_web_server.js`).
//
// Tools:
//   web_search { query, max_results?, provider? } — Brave/Tavily (keys via
//     env BRAVE_API_KEY / TAVILY_API_KEY) with DuckDuckGo fallback (keyless).
//   web_fetch { url, max_chars? } — page -> plain text (http/https only).
//
// Configuration is env-based (the MCP host process inherits the parent env,
// same as the `fetch` example server): WEBSEARCH_PROVIDER,
// WEBSEARCH_MAX_RESULTS, WEBSEARCH_TIMEOUT_MS, BRAVE_API_KEY, TAVILY_API_KEY.
// Auto-registered by ensureMcpConfig() in src/mcp.js alongside `local`.
// ---------------------------------------------------------------------------

import { fetchPageText, resolveWebSearchLimit, searchWeb } from "./websearch.js";

const TOOLS = [
    {
        name: "web_search",
        description: "Live web search. Mention-free query returns [{title, url, snippet}]. Keyless DuckDuckGo by default; Brave/Tavily when their API keys are set; google-ai (@live-gemini) uses Gemini grounding when GEMINI_API_KEY is set, else keyless Google scrape with DuckDuckGo fallback.",
        inputSchema: {
            type: "object",
            properties: {
                query: { type: "string", description: "Search query (required)." },
                max_results: { type: "integer", description: "Max results 1-10 (default 5)." },
                provider: { type: "string", description: "auto|duckduckgo|brave|tavily|google-ai (default auto)." },
            },
            required: ["query"],
        },
    },
    {
        name: "web_fetch",
        description: "Fetch an http(s) page and return its title + plain text (for reading a search result in full).",
        inputSchema: {
            type: "object",
            properties: {
                url: { type: "string", description: "http(s) URL to fetch (required)." },
                max_chars: { type: "integer", description: "Max characters to return (default 6000)." },
            },
            required: ["url"],
        },
    },
];

function settingsFromEnv() {
    return {
        websearch_enabled: true,
        websearch_provider: process.env.WEBSEARCH_PROVIDER || "auto",
        websearch_max_results: process.env.WEBSEARCH_MAX_RESULTS || 5,
        websearch_timeout_ms: process.env.WEBSEARCH_TIMEOUT_MS || 12000,
        brave_api_key: process.env.BRAVE_API_KEY || "",
        tavily_api_key: process.env.TAVILY_API_KEY || "",
        gemini_api_key: process.env.GEMINI_API_KEY || "",
        gemini_search_model: process.env.GEMINI_SEARCH_MODEL || process.env.FACTCHECK_GEMINI_MODEL || "gemini-2.5-flash",
    };
}

function textResult(text) {
    return { content: [{ type: "text", text: String(text) }] };
}

function formatResultsForTool(res) {
    if (!res || !res.success) return `Web search error: ${(res && res.error) || "unknown error"}`;
    const lines = [`Live web results for "${res.query}" (via ${res.provider}):`];
    (res.results || []).forEach((r, i) => {
        lines.push(`\n[${i + 1}] ${r.title || "(untitled)"}\nURL: ${r.url || ""}${r.snippet ? `\n${r.snippet}` : ""}`);
    });
    return lines.join("\n").slice(0, 12000);
}

async function handleCall(name, args = {}) {
    const settings = settingsFromEnv();
    if (name === "web_search") {
        const query = String(args.query || args.q || "").trim();
        if (!query) return { content: [{ type: "text", text: "query is required" }], isError: true };
        const maxResults = resolveWebSearchLimit(args.max_results ?? args.maxResults, settings);
        const provider = String(args.provider || "auto");
        const res = await searchWeb(query, settings, { provider, maxResults });
        if (!res.success) return { content: [{ type: "text", text: formatResultsForTool(res) }], isError: true };
        return textResult(formatResultsForTool(res));
    }
    if (name === "web_fetch") {
        const url = String(args.url || "").trim();
        if (!url) return { content: [{ type: "text", text: "url is required" }], isError: true };
        const max = Number(args.max_chars ?? args.maxChars) > 0
            ? Math.min(Number(args.max_chars ?? args.maxChars), 20000)
            : 6000;
        const res = await fetchPageText(url, settings, undefined, max);
        if (!res.success) return { content: [{ type: "text", text: res.error || "fetch failed" }], isError: true };
        return textResult(`📄 ${res.title || res.url}\n🔗 ${res.url}\n\n${res.text}`.slice(0, 20000));
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
                        serverInfo: { name: "dagowan-web", version: "1.0.0" },
                    });
                } else if (msg.method === "tools/list") {
                    reply(msg.id, { tools: TOOLS });
                } else if (msg.method === "tools/call") {
                    const params = msg.params || {};
                    reply(msg.id, await handleCall(params.name, params.arguments || {}));
                } else if (typeof msg.id !== "undefined" && msg.id !== null) {
                    replyError(msg.id, `Unknown method: ${msg.method}`);
                }
            } catch (err) {
                if (typeof msg.id !== "undefined" && msg.id !== null) replyError(msg.id, err.message || err);
            }
        })();
    }
});
