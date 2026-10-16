// ---------------------------------------------------------------------------
// Live web search for `@live-web` inline triggers + MCP `web` server.
//
// Zero-dependency (native fetch only), same conventions as factcheck_api.js:
//   - Pure parsers/resolvers are dependency-free and unit-tested.
//   - All network access goes through an injectable `fetchFn` so
//     `bun test` never touches the network.
//   - Settings win after env (same convention as providers.js).
//
// Trigger rule (see parseWebSearchInput / parseLiveGeminiInput):
//   - "@live-web" ANYWHERE inside a sentence triggers a live search, e.g.
//     "what is the price of BTC @live-web today" -> query without the token.
//   - "@live-gemini" ANYWHERE triggers a Google AI Mode search, e.g.
//     "explain black holes @live-gemini" -> query without the token.
//   - Leading "@live-web <query>", "@live-gemini <query>",
//     "@web-search <query>" / "@websearch
//     <query>" are the explicit search command forms (same trigger).
//   - "@web" is NEVER a search trigger: bare "@web" / "@web on|off|..."
//     stays the voice-bridge toggle owned by commands.js, and plain "@web"
//     inside a sentence is left alone (see isWebVoiceCommand).
//
// Provider chain (`auto` default):
//   1. Brave Search API (needs BRAVE_API_KEY / brave_api_key)
//   2. Tavily Search API (needs TAVILY_API_KEY / tavily_api_key)
//   3. DuckDuckGo (no key: HTML results + Instant Answer abstract)
//
// Google AI Mode (`@live-gemini`, provider `google-ai` / alias `gemini`):
//   1. Gemini API with `google_search` grounding (needs GEMINI_API_KEY /
//      gemini_api_key) — this is Google's official AI Mode backend: AI
//      answer + groundingChunks sources.
//   2. Keyless Google scrape (`google.com/search?udm=50` AI Mode + classic
//      fallback). Often JS-challenged for plain fetch, so best-effort.
//   3. DuckDuckGo fallback (reported via `fallback: true`).
// Explicit `--provider brave|tavily|duckduckgo|google-ai` (or websearch_provider)
// forces one engine, falling back to DuckDuckGo on failure.
//
// Env / settings (settings win after env):
//   WEBSEARCH_ENABLED / websearch_enabled (default true)
//   WEBSEARCH_PROVIDER / websearch_provider (default "auto")
//   WEBSEARCH_MAX_RESULTS / websearch_max_results (default 5, 1-10)
//   WEBSEARCH_TIMEOUT_MS / websearch_timeout_ms (default 12000, max 60000)
//   BRAVE_API_KEY / brave_api_key
//   TAVILY_API_KEY / tavily_api_key
//   GEMINI_API_KEY / gemini_api_key (shared with chat + @fact-check)
//   GEMINI_SEARCH_MODEL / gemini_search_model (default "gemini-2.5-flash")
// ---------------------------------------------------------------------------

export const WEBSEARCH_DEFAULT_MAX_RESULTS = 5;
export const WEBSEARCH_MAX_LIMIT = 10;
export const WEBSEARCH_DEFAULT_TIMEOUT_MS = 12000;
export const WEBSEARCH_MAX_TIMEOUT_MS = 60000;
export const WEBSEARCH_PROVIDERS = ["auto", "duckduckgo", "brave", "tavily", "google-ai"];
export const WEBSEARCH_USER_AGENT =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

export const DUCKDUCKGO_HTML_URL = "https://html.duckduckgo.com/html/";
export const DUCKDUCKGO_INSTANT_URL = "https://api.duckduckgo.com/";
export const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";
export const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
export const GOOGLE_AI_MODE_URL = "https://www.google.com/search";
export const GOOGLE_SEARCH_URL = "https://www.google.com/search";
export const GEMINI_SEARCH_DEFAULT_MODEL = "gemini-2.5-flash";

// --- settings ---------------------------------------------------------------

export function isWebSearchEnabled(settings = {}) {
    const v = (settings && settings.websearch_enabled) ?? process.env.WEBSEARCH_ENABLED ?? true;
    if (typeof v === "boolean") return v;
    return !["0", "false", "no", "off", "disable", "disabled"].includes(String(v).trim().toLowerCase());
}

export function resolveWebSearchProvider(value, settings = {}) {
    const raw = String(
        value !== undefined && value !== null && value !== ""
            ? value
            : (settings && settings.websearch_provider) || process.env.WEBSEARCH_PROVIDER || "auto"
    ).trim().toLowerCase().replace(/[\s_]+/g, "-");
    if (["ddg", "duck", "duck-duck-go", "html"].includes(raw)) return "duckduckgo";
    if (["brave", "brave-search", "bravesearch"].includes(raw)) return "brave";
    if (["tavily", "tavily-ai", "tavilyai"].includes(raw)) return "tavily";
    if (["google-ai", "googleai", "google", "gemini", "ai-mode", "aimode", "live-gemini", "gemini-search", "googlesearch"].includes(raw)) return "google-ai";
    if (raw === "duckduckgo") return "duckduckgo";
    return "auto";
}

export function resolveWebSearchLimit(value, settings = {}) {
    const fromSettings = Number(settings ? settings.websearch_max_results : NaN);
    const fromEnv = Number(process.env.WEBSEARCH_MAX_RESULTS || NaN);
    let n = Number(value);
    if (!Number.isFinite(n) || n <= 0) {
        if (Number.isFinite(fromSettings) && fromSettings > 0) n = fromSettings;
        else if (Number.isFinite(fromEnv) && fromEnv > 0) n = fromEnv;
        else n = WEBSEARCH_DEFAULT_MAX_RESULTS;
    }
    n = Math.floor(n);
    if (n < 1) return 1;
    if (n > WEBSEARCH_MAX_LIMIT) return WEBSEARCH_MAX_LIMIT;
    return n;
}

export function resolveWebSearchTimeoutMs(settings = {}) {
    const raw = (settings && settings.websearch_timeout_ms) ?? process.env.WEBSEARCH_TIMEOUT_MS ?? WEBSEARCH_DEFAULT_TIMEOUT_MS;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return WEBSEARCH_DEFAULT_TIMEOUT_MS;
    return Math.min(Math.floor(n), WEBSEARCH_MAX_TIMEOUT_MS);
}

export function getBraveApiKey(settings = {}) {
    return (settings && settings.brave_api_key) || process.env.BRAVE_API_KEY || "";
}

export function getTavilyApiKey(settings = {}) {
    return (settings && settings.tavily_api_key) || process.env.TAVILY_API_KEY || "";
}

export function getGeminiApiKey(settings = {}) {
    return (settings && settings.gemini_api_key) || process.env.GEMINI_API_KEY || "";
}

export function getGeminiSearchModel(settings = {}, override) {
    const fromOverride = String(override || "").trim();
    if (fromOverride) return fromOverride;
    const fromSettings = String((settings && (settings.gemini_search_model || settings.factcheck_gemini_model)) || "").trim();
    if (fromSettings) return fromSettings;
    const fromEnv = String(process.env.GEMINI_SEARCH_MODEL || process.env.FACTCHECK_GEMINI_MODEL || "").trim();
    if (fromEnv) return fromEnv;
    return GEMINI_SEARCH_DEFAULT_MODEL;
}

export function isGeminiSearchConfigured(settings = {}) {
    return Boolean(getGeminiApiKey(settings));
}

export function getWebStatus(settings = {}) {
    return {
        enabled: isWebSearchEnabled(settings),
        provider: resolveWebSearchProvider(undefined, settings),
        maxResults: resolveWebSearchLimit(undefined, settings),
        timeoutMs: resolveWebSearchTimeoutMs(settings),
        brave: Boolean(getBraveApiKey(settings)),
        tavily: Boolean(getTavilyApiKey(settings)),
        duckduckgo: true, // keyless, always available
        gemini: isGeminiSearchConfigured(settings), // Google AI Mode grounding
        googleAi: true, // keyless Google scrape attempted even without a key
    };
}

export function formatWebStatus(settings = {}) {
    const st = getWebStatus(settings);
    const lines = ["🌐 Live web search (@live-web):"];
    lines.push(`  • Enabled: ${st.enabled ? "yes" : "no"} (@set-setting websearch_enabled <on|off>)`);
    lines.push(`  • Provider: ${st.provider} (@set-setting websearch_provider <auto|duckduckgo|brave|tavily|google-ai>)`);
    lines.push(`  • Max results: ${st.maxResults} (@set-setting websearch_max_results <1-10>)`);
    lines.push(`  • Engines: duckduckgo (keyless, always on)${st.brave ? ", brave (key set)" : ", brave (no key — @set-api-key brave <key>)"}${st.tavily ? ", tavily (key set)" : ", tavily (no key — @set-api-key tavily <key>)"}${st.gemini ? ", google-ai / @live-gemini (Gemini grounding ready)" : ", google-ai / @live-gemini (keyless scrape; set @set-api-key gemini <key> for grounded AI answers)"}`);
    lines.push(`  • Usage: mention @live-web anywhere in a sentence ("latest BTC price @live-web"), or @web-search <query>, @web-fetch <url>`);
    lines.push(`  • Google AI Mode: mention @live-gemini anywhere ("explain black holes @live-gemini"), or @live-gemini <query>, or @web-search <query> --provider google-ai`);
    return lines.join("\n");
}

// --- trigger parsing --------------------------------------------------------
// Pure functions — no network, safe to call on every chat turn.

/**
 * True when `text` is a voice-bridge control command owned by commands.js:
 * any leading "@web" ("@web", "@web on|off|...", "@web <anything>"),
 * "@voice-socket ...", "@voice-server ...", "@dagowan ...".
 * "@web" is never a search trigger — live search uses "@live-web".
 */
export function isWebVoiceCommand(text) {
    const t = String(text || "").trim();
    const norm = t.startsWith("@") ? "/" + t.slice(1) : t;
    const low = norm.toLowerCase();
    if (low === "/voice-socket" || low.startsWith("/voice-socket ") ||
        low === "/voice-server" || low.startsWith("/voice-server ") ||
        low === "/dagowan" || low.startsWith("/dagowan ")) {
        return true;
    }
    if (low === "/web" || low.startsWith("/web ")) return true;
    return false;
}

/**
 * Detect an inline "@live-web" search trigger.
 * Returns null when there is no trigger (plain "@web" never triggers —
 * it belongs to the voice bridge). Otherwise `{ query, stripped }` where
 * `query` is the sentence minus all "@live-web" tokens
 * (whitespace-collapsed) and `stripped` is a boolean flag.
 */
export function parseWebSearchInput(text) {
    const raw = String(text || "");
    if (!raw) return null;
    // "@live-web" as a standalone token (not part of @live-web-search).
    // "@"-prefix NOT required to be leading — "within the sentence".
    if (!/@live-web(?![-\w])/i.test(raw)) return null;
    const query = raw
        .replace(/@live-web(?![-\w])/gi, " ")
        .replace(/\s+/g, " ")
        .trim();
    if (!query) return null;
    return { query, stripped: true };
}

/**
 * Detect an inline "@live-gemini" search trigger (Google AI Mode).
 * Same semantics as parseWebSearchInput: "@live-gemini" ANYWHERE in the
 * sentence triggers a Google AI Mode search. Returns null when absent,
 * otherwise `{ query, stripped }` with the token removed.
 */
export function parseLiveGeminiInput(text) {
    const raw = String(text || "");
    if (!raw) return null;
    if (!/@live-gemini(?![-\w])/i.test(raw)) return null;
    const query = raw
        .replace(/@live-gemini(?![-\w])/gi, " ")
        .replace(/\s+/g, " ")
        .trim();
    if (!query) return null;
    return { query, stripped: true };
}

/**
 * Leading explicit forms: "@live-web <query>" | "@web-search <query>" |
 * "@websearch <query>" | "@search-web <query>" | "@live-gemini <query>".
 * Returns null when `text` is not such a command, otherwise
 * `{ query, provider }`
 * (`query === ""` means usage help shown).
 * Inline "--provider <name>" / "--limit N" flags are parsed out.
 * "@live-gemini <query>" forces provider "google-ai" unless an explicit
 * --provider flag overrides it.
 */
export function parseWebSearchCommand(text, settings = {}) {
    const raw = String(text || "").trim();
    const norm = raw.startsWith("@") ? "/" + raw.slice(1) : raw;
    const low = norm.toLowerCase();
    const heads = ["/live-web", "/web-search", "/websearch", "/search-web", "/live-gemini", "/gemini-search", "/google-search"];
    const head = heads.find((h) => low === h || low.startsWith(h + " "));
    if (!head) return null;
    let body = norm.slice(head.length).trim();
    let provider = null;
    const provMatch = body.match(/\s--(?:provider|engine|via|source)(?:\s+|=)\s*([^\s]+)/i);
    if (provMatch) provider = provMatch[1];
    let limit = null;
    const limitMatch = body.match(/\s--(?:limit|max|max-results|max_results|n)(?:\s+|=)\s*(\d+)/i);
    if (limitMatch) limit = Number(limitMatch[1]);
    const query = body
        .replace(/\s--(?:provider|engine|via|source)(?:\s+|=)\s*[^\s]+/gi, " ")
        .replace(/\s--(?:limit|max|max-results|max_results|n)(?:\s+|=)\s*\d+/gi, " ")
        .replace(/\s+/g, " ")
        .trim();
    // "@live-gemini ..." defaults to the Google AI Mode engine unless the
    // user passed an explicit --provider flag.
    const isGeminiHead = ["/live-gemini", "/gemini-search", "/google-search"].includes(head);
    let effectiveProvider;
    if (provMatch) effectiveProvider = resolveWebSearchProvider(provider, settings);
    else if (isGeminiHead) effectiveProvider = resolveWebSearchProvider("google-ai", settings);
    else effectiveProvider = resolveWebSearchProvider(provider, settings);
    return {
        query,
        provider: effectiveProvider,
        maxResults: limit === null ? resolveWebSearchLimit(undefined, settings) : resolveWebSearchLimit(limit, settings),
    };
}

/** Leading "@web-fetch <url>" | "@webfetch <url>" (page -> text). */
export function parseWebFetchCommand(text) {
    const raw = String(text || "").trim();
    const norm = raw.startsWith("@") ? "/" + raw.slice(1) : raw;
    const low = norm.toLowerCase();
    const heads = ["/web-fetch", "/webfetch", "/web-open"];
    const head = heads.find((h) => low === h || low.startsWith(h + " "));
    if (!head) return null;
    return { url: norm.slice(head.length).trim() };
}

/** Leading "@web-status" (engine configuration overview). */
export function parseWebStatusCommand(text) {
    const raw = String(text || "").trim();
    const norm = raw.startsWith("@") ? "/" + raw.slice(1) : raw;
    const low = norm.toLowerCase();
    if (low === "/web-status" || low === "/websearch-status" || low === "/search-status") return { action: "status" };
    return null;
}

// --- html helpers (no DOM dependency) ---------------------------------------

const HTML_ENTITIES = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
    ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘",
    rdquo: "”", ldquo: "“", copy: "©", reg: "®", trade: "™",
};

export function decodeHtmlEntities(s) {
    return String(s || "")
        .replace(/&#(\d+);/g, (_m, n) => {
            try { return String.fromCodePoint(Number(n)); } catch { return ""; }
        })
        .replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => {
            try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ""; }
        })
        .replace(/&([a-zA-Z]+);/g, (m, name) => HTML_ENTITIES[name.toLowerCase()] ?? m);
}

export function stripHtml(html, maxChars = 6000) {
    let s = String(html || "");
    s = s.replace(/<script[\s\S]*?<\/script\s*>/gi, " ");
    s = s.replace(/<style[\s\S]*?<\/style\s*>/gi, " ");
    s = s.replace(/<noscript[\s\S]*?<\/noscript\s*>/gi, " ");
    s = s.replace(/<(br|p|div|li|tr|h[1-6])[^>]*>/gi, "\n");
    s = s.replace(/<[^>]*>/g, " ");
    s = decodeHtmlEntities(s);
    s = s.replace(/[ \t\f\v]+/g, " ");
    s = s.replace(/\n\s*\n\s*\n+/g, "\n\n");
    s = s.split("\n").map((l) => l.trim()).filter(Boolean).join("\n").trim();
    const n = Number(maxChars) > 0 ? Math.min(Number(maxChars), 20000) : 6000;
    if (s.length > n) return s.slice(0, n) + `\n…(truncated ${s.length - n} chars)`;
    return s;
}

export function extractTitle(html) {
    const m = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title\s*>/i);
    if (!m) return "";
    return decodeHtmlEntities(m[1].replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim().slice(0, 300);
}

/** DuckDuckGo wraps result hrefs as //duckduckgo.com/l/?uddg=<encoded>&... */
export function unwrapDuckHref(href) {
    const h = String(href || "").trim();
    if (!h) return "";
    try {
        const u = new URL(h, "https://duckduckgo.com");
        const uddg = u.searchParams.get("uddg");
        if (uddg) return decodeURIComponent(uddg);
    } catch {}
    return h;
}

export function parseDuckHtmlResults(html, limit = WEBSEARCH_DEFAULT_MAX_RESULTS) {
    const n = Math.min(Math.max(Number(limit) || WEBSEARCH_DEFAULT_MAX_RESULTS, 1), WEBSEARCH_MAX_LIMIT);
    const src = String(html || "");
    const linkRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a\s*>/gi;
    const snipRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div)\s*>/gi;
    const links = [];
    let m;
    while ((m = linkRe.exec(src)) !== null && links.length < n) {
        const url = unwrapDuckHref(decodeHtmlEntities(m[1]));
        if (!/^https?:\/\//i.test(url)) continue;
        if (/^https?:\/\/(duckduckgo\.com|.*\.duckduckgo\.com)(\/|$)/i.test(url)) continue;
        const title = decodeHtmlEntities(m[2].replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
        if (!title) continue;
        links.push({ title: title.slice(0, 300), url, snippet: "" });
    }
    const snips = [];
    while ((m = snipRe.exec(src)) !== null && snips.length < links.length) {
        snips.push(decodeHtmlEntities(m[1].replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim().slice(0, 500));
    }
    links.forEach((r, i) => { if (snips[i]) r.snippet = snips[i]; });
    return links.slice(0, n);
}

export function parseDuckInstantAnswer(data) {
    const d = (data && typeof data === "object") ? data : {};
    const out = [];
    const abstract = String(d.AbstractText || "").trim();
    if (abstract) {
        out.push({
            title: String(d.Heading || "DuckDuckGo Instant Answer").slice(0, 300),
            url: String(d.AbstractURL || "https://duckduckgo.com/"),
            snippet: abstract.slice(0, 800),
        });
    }
    const topics = Array.isArray(d.RelatedTopics) ? d.RelatedTopics : [];
    const flat = [];
    for (const t of topics) {
        if (t && Array.isArray(t.Topics)) flat.push(...t.Topics);
        else if (t) flat.push(t);
        if (flat.length >= 10) break;
    }
    for (const t of flat.slice(0, 10)) {
        const url = String((t && (t.FirstURL || t.FirstUrl)) || "").trim();
        const text = String((t && t.Text) || "").trim();
        if (!url || !text) continue;
        const clean = text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
        const cut = clean.indexOf(" - ");
        out.push({
            title: (cut > 0 ? clean.slice(0, cut) : clean.slice(0, 120)).slice(0, 300),
            url,
            snippet: (cut > 0 ? clean.slice(cut + 3) : clean).slice(0, 500),
        });
    }
    return out;
}

/** Google wraps outbound links as /url?q=<encoded>&... */
export function unwrapGoogleHref(href) {
    const h = String(href || "").trim();
    if (!h) return "";
    try {
        const u = new URL(h, "https://www.google.com");
        if (u.pathname === "/url") {
            const q = u.searchParams.get("q");
            if (q) return q;
        }
    } catch {}
    return h;
}

export function parseGoogleHtmlResults(html, limit = WEBSEARCH_DEFAULT_MAX_RESULTS) {
    const n = Math.min(Math.max(Number(limit) || WEBSEARCH_DEFAULT_MAX_RESULTS, 1), WEBSEARCH_MAX_LIMIT);
    const src = String(html || "");
    const out = [];
    const seen = new Set();
    // Classic Google anchors: <a href="/url?q=https://..."><h3>Title</h3></a>
    // plus newer <a jsname href="https://..."> variants. Scan generically.
    const anchorRe = /<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a\s*>/gi;
    let m;
    while ((m = anchorRe.exec(src)) !== null && out.length < n * 3) {
        let url = decodeHtmlEntities(m[1]);
        url = unwrapGoogleHref(url);
        if (!/^https?:\/\//i.test(url)) continue;
        if (/^https?:\/\/(www\.)?google\.[^/]*(\/|$)/i.test(url)) continue;
        if (/^https?:\/\/.*\.google\.[^/]*\/search/i.test(url)) continue;
        if (url.includes("enablejs") || url.includes("httpservice")) continue;
        const inner = String(m[2] || "");
        if (/<script|style/i.test(inner)) continue;
        const title = decodeHtmlEntities(inner.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
        if (!title || title.length < 8 || title.length > 300) continue;
        if (/^Images|Videos|News|Maps|Shopping|More|All$/i.test(title)) continue;
        if (seen.has(url)) continue;
        seen.add(url);
        out.push({ title: title.slice(0, 300), url, snippet: "" });
        if (out.length >= n) break;
    }
    return out.slice(0, n);
}

/**
 * Best-effort extraction of Google's AI Overview / AI Mode answer text
 * from server-rendered HTML. Google changes markup often; this looks for
 * common containers and falls back to "" when only the JS shell is served
 * (datacenter fetches usually get the enablejs challenge).
 */
export function parseGoogleAiAnswer(html) {
    const src = String(html || "");
    if (!src || src.includes("enablejs")) return "";
    const candidates = [
        /<div[^>]*data-attrid="[^"]*dmec[^"]*"[^>]*>([\s\S]{20,4000}?)<\/div\s*>/i,
        /<div[^>]*(?:class="[^"]*(?:AI-overview|ai-overview|generative|ai-answer)[^"]*")[^>]*>([\s\S]{20,6000}?)<\/div\s*>/i,
        /<span[^>]*data-ved[^>]*>([\s\S]{40,4000}?)<\/span\s*>/i,
    ];
    for (const re of candidates) {
        const m = src.match(re);
        if (m) {
            const text = decodeHtmlEntities(m[1].replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
            if (text && text.length > 40) return text.slice(0, 2000);
        }
    }
    return "";
}

// --- fetch plumbing ---------------------------------------------------------

function httpError(status, bodyText) {
    return new Error(`HTTP ${status}${bodyText ? `: ${String(bodyText).slice(0, 200)}` : ""}`);
}

async function fetchWithTimeout(url, options = {}, fetchFn, timeoutMs) {
    const run = fetchFn || fetch;
    const ms = Number(timeoutMs) > 0 ? Number(timeoutMs) : WEBSEARCH_DEFAULT_TIMEOUT_MS;
    if (fetchFn) return run(url, options);
    if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) {
        return run(url, { ...options, signal: AbortSignal.timeout(ms) });
    }
    return run(url, options);
}

async function fetchText(url, options, fetchFn, timeoutMs) {
    const res = await fetchWithTimeout(url, options, fetchFn, timeoutMs);
    if (!res.ok) {
        let body = "";
        try { body = await res.text(); } catch {}
        throw httpError(res.status, body);
    }
    return res.text();
}

async function fetchJson(url, options, fetchFn, timeoutMs) {
    const res = await fetchWithTimeout(url, options, fetchFn, timeoutMs);
    if (!res.ok) {
        let body = "";
        try { body = await res.text(); } catch {}
        throw httpError(res.status, body);
    }
    return res.json();
}

// --- engines ----------------------------------------------------------------

export async function searchDuckDuckGo(query, settings = {}, fetchFn) {
    const q = String(query || "").trim();
    if (!q) return { success: false, provider: "duckduckgo", query: q, results: [], error: "Usage: provide a search query." };
    const limit = resolveWebSearchLimit(undefined, settings);
    const timeoutMs = resolveWebSearchTimeoutMs(settings);
    const htmlUrl = `${DUCKDUCKGO_HTML_URL}?q=${encodeURIComponent(q)}`;
    const instantUrl = `${DUCKDUCKGO_INSTANT_URL}?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1`;
    const [htmlSettled, instantSettled] = await Promise.allSettled([
        fetchText(htmlUrl, {
            headers: { "User-Agent": WEBSEARCH_USER_AGENT, Accept: "text/html", "Accept-Language": "en-US,en;q=0.9" },
        }, fetchFn, timeoutMs),
        fetchJson(instantUrl, {
            headers: { "User-Agent": WEBSEARCH_USER_AGENT, Accept: "application/json" },
        }, fetchFn, timeoutMs),
    ]);
    const results = [];
    if (instantSettled.status === "fulfilled") {
        try {
            const instant = parseDuckInstantAnswer(instantSettled.value);
            if (instant.length > 0 && instant[0].snippet) results.push({ ...instant[0], source: "instant-answer" });
        } catch {}
    }
    if (htmlSettled.status === "fulfilled") {
        try {
            for (const r of parseDuckHtmlResults(htmlSettled.value, limit)) {
                if (results.length >= limit + 1) break;
                if (results.some((x) => x.url === r.url)) continue;
                results.push({ ...r, source: "html" });
            }
        } catch {}
    }
    if (results.length === 0) {
        const err = htmlSettled.status === "rejected"
            ? (htmlSettled.reason && (htmlSettled.reason.message || String(htmlSettled.reason)))
            : `No results for "${q}".`;
        return { success: false, provider: "duckduckgo", query: q, results: [], error: `DuckDuckGo error: ${err}` };
    }
    return { success: true, provider: "duckduckgo", query: q, results: results.slice(0, limit) };
}

export async function searchBrave(query, settings = {}, fetchFn) {
    const q = String(query || "").trim();
    if (!q) return { success: false, provider: "brave", query: q, results: [], error: "Usage: provide a search query." };
    const key = getBraveApiKey(settings);
    if (!key) {
        return { success: false, provider: "brave", query: q, results: [], error: "Brave API key is not configured. Set it with @set-api-key brave <key> (or BRAVE_API_KEY)." };
    }
    const limit = resolveWebSearchLimit(undefined, settings);
    const timeoutMs = resolveWebSearchTimeoutMs(settings);
    const url = `${BRAVE_SEARCH_URL}?q=${encodeURIComponent(q)}&count=${limit}`;
    try {
        const data = await fetchJson(url, {
            headers: { Accept: "application/json", "X-Subscription-Token": key },
        }, fetchFn, timeoutMs);
        const items = (data && data.web && Array.isArray(data.web.results)) ? data.web.results : [];
        const results = items.slice(0, limit).map((r) => ({
            title: String((r && r.title) || "(untitled)").slice(0, 300),
            url: String((r && r.url) || ""),
            snippet: String((r && (r.description || r.snippet)) || "").slice(0, 800),
        })).filter((r) => r.url);
        if (results.length === 0) return { success: false, provider: "brave", query: q, results: [], error: `No Brave results for "${q}".` };
        return { success: true, provider: "brave", query: q, results };
    } catch (err) {
        return { success: false, provider: "brave", query: q, results: [], error: `Brave error: ${err.message || String(err)}` };
    }
}

export async function searchTavily(query, settings = {}, fetchFn) {
    const q = String(query || "").trim();
    if (!q) return { success: false, provider: "tavily", query: q, results: [], error: "Usage: provide a search query." };
    const key = getTavilyApiKey(settings);
    if (!key) {
        return { success: false, provider: "tavily", query: q, results: [], error: "Tavily API key is not configured. Set it with @set-api-key tavily <key> (or TAVILY_API_KEY)." };
    }
    const limit = resolveWebSearchLimit(undefined, settings);
    const timeoutMs = resolveWebSearchTimeoutMs(settings);
    try {
        const data = await fetchJson(TAVILY_SEARCH_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ api_key: key, query: q, max_results: limit, include_answer: false, search_depth: "basic" }),
        }, fetchFn, timeoutMs);
        const items = data && Array.isArray(data.results) ? data.results : [];
        const results = items.slice(0, limit).map((r) => ({
            title: String((r && r.title) || "(untitled)").slice(0, 300),
            url: String((r && r.url) || ""),
            snippet: String((r && (r.content || r.snippet)) || "").slice(0, 800),
        })).filter((r) => r.url);
        if (results.length === 0) return { success: false, provider: "tavily", query: q, results: [], error: `No Tavily results for "${q}".` };
        return { success: true, provider: "tavily", query: q, results };
    } catch (err) {
        return { success: false, provider: "tavily", query: q, results: [], error: `Tavily error: ${err.message || String(err)}` };
    }
}

/**
 * Gemini API with `google_search` grounding — Google's official AI Mode
 * backend. Pure REST fetch (no SDK) so `bun test` can inject `fetchFn`.
 * Returns `{ answer, results }` where results come from groundingChunks /
 * groundingSupports citation URLs.
 */
export async function searchGeminiWithGrounding(query, settings = {}, fetchFn, modelOverride) {
    const q = String(query || "").trim();
    if (!q) return { success: false, provider: "google-ai", query: q, results: [], error: "Usage: provide a search query." };
    const key = getGeminiApiKey(settings);
    if (!key) {
        return { success: false, provider: "google-ai", query: q, results: [], error: "Gemini API key is not configured. Set it with @set-api-key gemini <key> (or GEMINI_API_KEY)." };
    }
    const model = getGeminiSearchModel(settings, modelOverride);
    const limit = resolveWebSearchLimit(undefined, settings);
    const timeoutMs = resolveWebSearchTimeoutMs(settings);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
    try {
        const data = await fetchJson(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                contents: [{ role: "user", parts: [{ text: q }] }],
                tools: [{ google_search: {} }],
                generationConfig: { temperature: 0.2, maxOutputTokens: 2048 },
            }),
        }, fetchFn, timeoutMs);
        const cand = data && Array.isArray(data.candidates) && data.candidates[0] ? data.candidates[0] : null;
        const parts = (cand && cand.content && Array.isArray(cand.content.parts)) ? cand.content.parts : [];
        const answer = parts.map((p) => (p && p.text ? p.text : "")).join("").trim();
        const meta = (cand && cand.groundingMetadata) || {};
        const chunks = Array.isArray(meta.groundingChunks) ? meta.groundingChunks : [];
        const results = [];
        const seen = new Set();
        for (const c of chunks) {
            const web = c && c.web ? c.web : null;
            const urlOut = web && (web.uri || web.url) ? String(web.uri || web.url) : "";
            const title = web && web.title ? String(web.title) : "";
            if (!urlOut || !/^https?:\/\//i.test(urlOut) || seen.has(urlOut)) continue;
            seen.add(urlOut);
            results.push({
                title: (title || urlOut).slice(0, 300),
                url: urlOut,
                snippet: "",
            });
            if (results.length >= limit) break;
        }
        // Fallback: some models return inline [1](url) markdown citations.
        if (results.length === 0 && answer) {
            const linkRe = /\[([^\]]{3,120})\]\((https?:\/\/[^)\s]+)\)/g;
            let m;
            while ((m = linkRe.exec(answer)) !== null && results.length < limit) {
                if (seen.has(m[2])) continue;
                seen.add(m[2]);
                results.push({ title: m[1].slice(0, 300), url: m[2], snippet: "" });
            }
        }
        if (!answer && results.length === 0) {
            return { success: false, provider: "google-ai", query: q, results: [], error: "Gemini returned an empty grounded answer." };
        }
        // When the model answers but cites no URLs, still return the answer
        // with a single self-reference result so chat grounding works.
        const finalResults = results.length > 0 ? results : [{
            title: `Gemini grounded answer for "${q.slice(0, 80)}"`,
            url: `https://www.google.com/search?q=${encodeURIComponent(q)}&udm=50`,
            snippet: answer.slice(0, 800),
        }];
        return { success: true, provider: "google-ai", query: q, results: finalResults.slice(0, limit), answer: answer.slice(0, 4000), model };
    } catch (err) {
        return { success: false, provider: "google-ai", query: q, results: [], error: `Google AI error: ${err.message || String(err)}` };
    }
}

/**
 * Keyless Google scrape: AI Mode (`udm=50`) first, classic search fallback.
 * Best-effort — Google often serves a JS challenge to datacenter fetches,
 * in which case this returns success:false and the caller falls back.
 */
export async function searchGoogleScrape(query, settings = {}, fetchFn) {
    const q = String(query || "").trim();
    if (!q) return { success: false, provider: "google-ai", query: q, results: [], error: "Usage: provide a search query." };
    const limit = resolveWebSearchLimit(undefined, settings);
    const timeoutMs = resolveWebSearchTimeoutMs(settings);
    const headers = {
        "User-Agent": WEBSEARCH_USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
    };
    const aiUrl = `${GOOGLE_AI_MODE_URL}?q=${encodeURIComponent(q)}&udm=50&hl=en&gl=us&num=10`;
    const webUrl = `${GOOGLE_SEARCH_URL}?q=${encodeURIComponent(q)}&hl=en&gl=us&num=10`;
    const [aiSettled, webSettled] = await Promise.allSettled([
        fetchText(aiUrl, { headers }, fetchFn, timeoutMs),
        fetchText(webUrl, { headers }, fetchFn, timeoutMs),
    ]);
    let answer = "";
    const merged = [];
    const seen = new Set();
    for (const s of [aiSettled, webSettled]) {
        if (s.status !== "fulfilled" || !s.value) continue;
        try {
            if (!answer) answer = parseGoogleAiAnswer(s.value);
            for (const r of parseGoogleHtmlResults(s.value, limit)) {
                if (merged.length >= limit) break;
                if (seen.has(r.url)) continue;
                seen.add(r.url);
                merged.push({ ...r, source: "google" });
            }
        } catch {}
        if (merged.length >= limit) break;
    }
    if (merged.length === 0 && !answer) {
        const err = aiSettled.status === "rejected"
            ? (aiSettled.reason && (aiSettled.reason.message || String(aiSettled.reason)))
            : "Google returned a JS challenge (no server-rendered results). Set @set-api-key gemini <key> for grounded AI answers.";
        return { success: false, provider: "google-ai", query: q, results: [], error: `Google AI error: ${err}` };
    }
    const results = merged.length > 0 ? merged.slice(0, limit) : [{
        title: `Google AI Mode answer for "${q.slice(0, 80)}"`,
        url: aiUrl,
        snippet: (answer || "").slice(0, 800),
    }];
    return { success: true, provider: "google-ai", query: q, results, ...(answer ? { answer: answer.slice(0, 4000) } : {}) };
}

/**
 * Google AI Mode entry point (`@live-gemini`, provider `google-ai`).
 * Tier 1: Gemini API grounding (needs GEMINI_API_KEY).
 * Tier 2: keyless Google scrape (best-effort).
 */
export async function searchGoogleAi(query, settings = {}, fetchFn, modelOverride) {
    const q = String(query || "").trim();
    if (!q) return { success: false, provider: "google-ai", query: q, results: [], error: "Usage: provide a search query." };
    if (isGeminiSearchConfigured(settings)) {
        const grounded = await searchGeminiWithGrounding(query, settings, fetchFn, modelOverride);
        if (grounded.success) return grounded;
        const scrape = await searchGoogleScrape(query, settings, fetchFn);
        if (scrape.success) return { ...scrape, fallback: true, engineError: grounded.error };
        return grounded;
    }
    return searchGoogleScrape(query, settings, fetchFn);
}

/**
 * Default entry point. `opts.provider` forces an engine ("auto" default);
 * `opts.maxResults` overrides the configured default for this call only.
 * On failure the forced/keyed engine falls back to DuckDuckGo (reported
 * via `fallback: true` + `engineError`) so cloud models still get context.
 */
export async function searchWeb(query, settings = {}, opts = {}, fetchFn) {
    const q = String(query || "").trim();
    if (!q) return { success: false, provider: "duckduckgo", query: q, results: [], error: "Usage: provide a search query." };
    const merged = { ...(settings || {}) };
    if (opts && opts.maxResults !== undefined && opts.maxResults !== null) {
        merged.websearch_max_results = resolveWebSearchLimit(opts.maxResults, settings);
    }
    const provider = resolveWebSearchProvider(opts && opts.provider !== undefined ? opts.provider : undefined, merged);
    const runEngine = (p) => {
        if (p === "brave") return searchBrave(q, merged, fetchFn);
        if (p === "tavily") return searchTavily(q, merged, fetchFn);
        if (p === "google-ai") return searchGoogleAi(q, merged, fetchFn, opts && (opts.model || opts.geminiModel));
        return searchDuckDuckGo(q, merged, fetchFn);
    };
    if (provider === "auto") {
        if (getBraveApiKey(merged)) {
            const r = await runEngine("brave");
            if (r.success) return r;
            const ddg = await runEngine("duckduckgo");
            if (ddg.success) return { ...ddg, fallback: true, engineError: r.error };
            return r;
        }
        if (getTavilyApiKey(merged)) {
            const r = await runEngine("tavily");
            if (r.success) return r;
            const ddg = await runEngine("duckduckgo");
            if (ddg.success) return { ...ddg, fallback: true, engineError: r.error };
            return r;
        }
        return runEngine("duckduckgo");
    }
    const res = await runEngine(provider);
    if (!res.success && provider !== "duckduckgo") {
        const ddg = await runEngine("duckduckgo");
        if (ddg.success) return { ...ddg, fallback: true, engineError: res.error };
    }
    return res;
}

// --- page fetch --------------------------------------------------------------

/**
 * Fetch a page and return plain text (title + snippet). SSRF-safe-ish:
 * only http(s) URLs are fetched; file/data/javascript schemes are refused.
 */
export async function fetchPageText(url, settings = {}, fetchFn, maxChars = 6000) {
    const u = String(url || "").trim();
    if (!u) return { success: false, url: u, title: "", text: "", error: "Usage: @web-fetch <url>." };
    let parsed;
    try {
        parsed = new URL(u);
    } catch {
        return { success: false, url: u, title: "", text: "", error: `Invalid URL: ${u}` };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return { success: false, url: u, title: "", text: "", error: `Refused (only http/https are fetched): ${u}` };
    }
    const timeoutMs = resolveWebSearchTimeoutMs(settings);
    try {
        const res = await fetchWithTimeout(u, {
            headers: { "User-Agent": WEBSEARCH_USER_AGENT, Accept: "text/html,text/plain,*/*", "Accept-Language": "en-US,en;q=0.9" },
        }, fetchFn, timeoutMs);
        if (!res.ok) {
            let body = "";
            try { body = await res.text(); } catch {}
            throw httpError(res.status, body);
        }
        const contentType = (res.headers && typeof res.headers.get === "function" ? res.headers.get("content-type") : "") || "";
        const raw = await res.text();
        if (/application\/json/i.test(contentType)) {
            const text = String(raw).slice(0, Math.min(Number(maxChars) > 0 ? Number(maxChars) : 6000, 20000));
            return { success: true, url: u, title: "", text };
        }
        const title = extractTitle(raw);
        const text = stripHtml(raw, maxChars);
        if (!text) return { success: false, url: u, title, text: "", error: `No readable text found at ${u}.` };
        return { success: true, url: u, title, text };
    } catch (err) {
        return { success: false, url: u, title: "", text: "", error: `Fetch error: ${err.message || String(err)}` };
    }
}

// --- formatting --------------------------------------------------------------

export function formatWebResults(res) {
    if (!res || !res.success) {
        return `⚠️ Web search error: ${(res && res.error) || "unknown error"}`;
    }
    const results = Array.isArray(res.results) ? res.results : [];
    const isGemini = String((res && res.provider) || "") === "google-ai";
    const lines = [isGemini
        ? `🤖 Google AI Mode results for: "${res.query || ""}" (via google-ai)`
        : `🌐 Live web results for: "${res.query || ""}" (via ${res.provider || "web"})`];
    if (isGemini && res.answer) {
        lines.push("");
        lines.push(`✨ AI answer (${res.model || GEMINI_SEARCH_DEFAULT_MODEL}):`);
        lines.push(String(res.answer).slice(0, 1500));
    }
    results.forEach((r, i) => {
        lines.push(`\n[${i + 1}] ${r.title || "(untitled)"}`);
        lines.push(`    🔗 ${r.url || ""}`);
        if (r.snippet) lines.push(`    ${String(r.snippet).slice(0, 400)}`);
    });
    if (res.fallback && res.engineError) lines.push(`\nℹ️ Keyed engine unavailable (${res.engineError}); fell back to DuckDuckGo.`);
    lines.push("\n⚠️ Verify important facts against the linked pages — snippets can be stale.");
    return lines.join("\n");
}

export function formatPageText(res) {
    if (!res || !res.success) return `⚠️ Web fetch error: ${(res && res.error) || "unknown error"}`;
    const lines = [`📄 ${res.title || res.url}`, `🔗 ${res.url}`];
    lines.push("");
    lines.push(String(res.text || "").slice(0, 4000));
    return lines.join("\n");
}

/**
 * System-prompt block injected into the model messages so ANY provider
 * (Ollama local, OpenAI, Gemini, Claude, Grok, Mistral) answers with live context.
 */
export function buildWebSystemBlock(res) {
    if (!res || !res.success) return "";
    const results = (Array.isArray(res.results) ? res.results : []).slice(0, WEBSEARCH_MAX_LIMIT);
    if (results.length === 0 && !res.answer) return "";
    const isGemini = String(res.provider || "") === "google-ai";
    const lines = results.map((r, i) => `${i + 1}. "${r.title || "(untitled)"}" — ${r.snippet || "(no snippet)"}\n   Source: ${r.url || ""}`);
    const head = isGemini
        ? `[Google AI Mode Results for "${res.query || ""}" (via google-ai, fetched just now — prefer this over training-data knowledge for current facts)]:`
        : `[Live Web Search Results for "${res.query || ""}" (via ${res.provider || "web"}, fetched just now — prefer this over training-data knowledge for current facts)]:`;
    const answerBlock = isGemini && res.answer ? `AI answer: ${String(res.answer).slice(0, 3000)}\n` : "";
    return `${head}\n${answerBlock}${lines.join("\n")}\nAnswer using these results where relevant; cite source numbers [1], [2] inline. If the results do not cover the question, say so instead of guessing.`.slice(0, 8000);
}

// --- high-level chat integration ---------------------------------------------
// Single choke point used by CLI / Telegram / WhatsApp / Web voice socket so
// every surface behaves identically.

/**
 * Detect an inline "@live-web" / "@live-gemini" trigger (or explicit
 * "@live-web" / "@live-gemini" / "@web-search" command) and run the search.
 * Returns `{ triggered: false }` when there is nothing to
 * do (no token, voice command, search disabled, empty query) — callers then
 * continue unchanged. Otherwise `{ triggered: true, query, searchRes, block }`
 * where `block` is the system-prompt text ("" when the search failed —
 * check `searchRes.error` for the reason).
 *
 * "@live-gemini" forces the Google AI Mode engine (`google-ai`); "@live-web"
 * uses the configured provider chain. A leading "@live-gemini <query>"
 * command is also handled here so every surface (CLI / dashboard /
 * Telegram / WhatsApp / voice) behaves identically with no caller changes.
 */
export async function runWebSearchForPrompt(promptText, settings = {}, fetchFn, opts = {}) {
    const raw = String(promptText || "");
    if (!raw || !isWebSearchEnabled(settings)) return { triggered: false };
    let query = "";
    let provider;
    let maxResults;
    const cmd = parseWebSearchCommand(raw, settings);
    if (cmd) {
        if (!cmd.query) return { triggered: false, reason: "usage" };
        query = cmd.query;
        provider = cmd.provider;
        maxResults = cmd.maxResults;
    } else {
        const geminiInline = parseLiveGeminiInput(raw);
        if (geminiInline) {
            query = geminiInline.query;
            provider = "google-ai";
        } else {
            const inline = parseWebSearchInput(raw);
            if (!inline) return { triggered: false };
            query = inline.query;
        }
    }
    if (!query) return { triggered: false };
    try {
        const searchRes = await searchWeb(query, settings, { provider, maxResults, ...(opts || {}) }, fetchFn);
        if (!searchRes.success) return { triggered: true, query, searchRes, block: "" };
        return { triggered: true, query, searchRes, block: buildWebSystemBlock(searchRes) };
    } catch (err) {
        return {
            triggered: true,
            query,
            searchRes: { success: false, provider: "web", query, results: [], error: err.message || String(err) },
            block: "",
        };
    }
}

/**
 * Explicit `@live-gemini` entry point (mirrors runWebSearchForPrompt but
 * only fires for the Google AI Mode token). Useful for callers that want
 * to handle the two triggers separately; `runWebSearchForPrompt` already
 * covers both, so most code should keep calling that.
 */
export async function runLiveGeminiForPrompt(promptText, settings = {}, fetchFn, opts = {}) {
    const raw = String(promptText || "");
    if (!raw || !isWebSearchEnabled(settings)) return { triggered: false };
    const cmd = parseWebSearchCommand(raw, settings);
    if (cmd) {
        const head = raw.trim().toLowerCase().startsWith("@live-gemini") || raw.trim().toLowerCase().startsWith("/live-gemini");
        if (!head) return { triggered: false };
        if (!cmd.query) return { triggered: false, reason: "usage" };
        try {
            const searchRes = await searchWeb(cmd.query, settings, { provider: cmd.provider, maxResults: cmd.maxResults, ...(opts || {}) }, fetchFn);
            if (!searchRes.success) return { triggered: true, query: cmd.query, searchRes, block: "" };
            return { triggered: true, query: cmd.query, searchRes, block: buildWebSystemBlock(searchRes) };
        } catch (err) {
            return { triggered: true, query: cmd.query, searchRes: { success: false, provider: "google-ai", query: cmd.query, results: [], error: err.message || String(err) }, block: "" };
        }
    }
    const inline = parseLiveGeminiInput(raw);
    if (!inline) return { triggered: false };
    try {
        const searchRes = await searchWeb(inline.query, settings, { provider: "google-ai", ...(opts || {}) }, fetchFn);
        if (!searchRes.success) return { triggered: true, query: inline.query, searchRes, block: "" };
        return { triggered: true, query: inline.query, searchRes, block: buildWebSystemBlock(searchRes) };
    } catch (err) {
        return { triggered: true, query: inline.query, searchRes: { success: false, provider: "google-ai", query: inline.query, results: [], error: err.message || String(err) }, block: "" };
    }
}
