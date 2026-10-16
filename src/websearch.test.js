import { describe, expect, test } from "bun:test";
import {
    buildWebSystemBlock,
    decodeHtmlEntities,
    fetchPageText,
    formatWebResults,
    formatWebStatus,
    getGeminiApiKey,
    getGeminiSearchModel,
    getWebStatus,
    isGeminiSearchConfigured,
    isWebSearchEnabled,
    isWebVoiceCommand,
    parseDuckHtmlResults,
    parseDuckInstantAnswer,
    parseGoogleAiAnswer,
    parseGoogleHtmlResults,
    parseLiveGeminiInput,
    parseWebFetchCommand,
    parseWebSearchCommand,
    parseWebSearchInput,
    parseWebStatusCommand,
    resolveWebSearchLimit,
    resolveWebSearchProvider,
    resolveWebSearchTimeoutMs,
    runLiveGeminiForPrompt,
    runWebSearchForPrompt,
    searchBrave,
    searchDuckDuckGo,
    searchGeminiWithGrounding,
    searchGoogleAi,
    searchGoogleScrape,
    searchTavily,
    searchWeb,
    stripHtml,
    unwrapDuckHref,
    unwrapGoogleHref,
} from "./websearch.js";

describe("websearch trigger parsing", () => {
    test("inline @live-web anywhere in the sentence triggers", () => {
        expect(parseWebSearchInput("latest BTC price @live-web today")).toEqual({
            query: "latest BTC price today",
            stripped: true,
        });
        expect(parseWebSearchInput("@live-web what is the weather in Vilnius")).toEqual({
            query: "what is the weather in Vilnius",
            stripped: true,
        });
        expect(parseWebSearchInput("tell me @LIVE-WEB about cats")).toEqual({
            query: "tell me about cats",
            stripped: true,
        });
    });

    test("plain @web never triggers a search (voice bridge owns it)", () => {
        expect(parseWebSearchInput("latest BTC price @web today")).toBeNull();
        expect(parseWebSearchInput("@web what is the weather in Vilnius")).toBeNull();
        expect(parseWebSearchInput("@web")).toBeNull();
        expect(parseWebSearchInput("@web on")).toBeNull();
        expect(parseWebSearchInput("@web latest BTC price")).toBeNull();
    });

    test("no trigger without the token", () => {
        expect(parseWebSearchInput("hello how are you")).toBeNull();
        expect(parseWebSearchInput("@website design tips")).toBeNull();
        expect(parseWebSearchInput("@web-search query")).toBeNull();
        expect(parseWebSearchInput("@live-web")).toBeNull();
        expect(parseWebSearchInput("")).toBeNull();
    });

    test("every leading @web form stays a voice command (no search)", () => {
        expect(isWebVoiceCommand("@web")).toBe(true);
        expect(isWebVoiceCommand("@web off")).toBe(true);
        expect(isWebVoiceCommand("@web on")).toBe(true);
        expect(isWebVoiceCommand("@web latest BTC price")).toBe(true);
        expect(parseWebSearchInput("@web latest BTC price")).toBeNull();
        expect(isWebVoiceCommand("@voice-socket")).toBe(true);
        expect(isWebVoiceCommand("@dagowan")).toBe(true);
        expect(isWebVoiceCommand("@live-web foo")).toBe(false);
        expect(isWebVoiceCommand("@live-gemini foo")).toBe(false);
    });

    test("inline @live-gemini anywhere triggers Google AI Mode", () => {
        expect(parseLiveGeminiInput("explain black holes @live-gemini please")).toEqual({
            query: "explain black holes please",
            stripped: true,
        });
        expect(parseLiveGeminiInput("@live-gemini what is the weather")).toEqual({
            query: "what is the weather",
            stripped: true,
        });
        expect(parseLiveGeminiInput("hello how are you")).toBeNull();
        expect(parseLiveGeminiInput("@live-gemini")).toBeNull();
        expect(parseLiveGeminiInput("")).toBeNull();
        // @live-web parser must not fire on @live-gemini and vice versa.
        expect(parseWebSearchInput("explain this @live-gemini")).toBeNull();
        expect(parseLiveGeminiInput("latest BTC @live-web")).toBeNull();
    });

    test("explicit @web-search command form (plus @live-web leading form)", () => {
        const cmd = parseWebSearchCommand("@web-search latest BTC price");
        expect(cmd.query).toBe("latest BTC price");
        expect(parseWebSearchCommand("@live-web latest BTC price").query).toBe("latest BTC price");
        expect(parseWebSearchCommand("@live-gemini latest BTC price")).toMatchObject({
            query: "latest BTC price",
            provider: "google-ai",
        });
        expect(parseWebSearchCommand("@web-search foo --provider gemini --limit 3")).toMatchObject({
            query: "foo",
            provider: "google-ai",
            maxResults: 3,
        });
        expect(parseWebSearchCommand("@websearch foo --provider brave --limit 3")).toMatchObject({
            query: "foo",
            provider: "brave",
            maxResults: 3,
        });
        expect(parseWebSearchCommand("@web-search").query).toBe("");
        expect(parseWebSearchCommand("@live-web").query).toBe("");
        expect(parseWebSearchCommand("@live-gemini").query).toBe("");
        expect(parseWebSearchCommand("just chatting")).toBeNull();
        expect(parseWebSearchCommand("@web latest BTC price")).toBeNull();
    });

    test("@web-fetch and @web-status parsers", () => {
        expect(parseWebFetchCommand("@web-fetch https://example.com")).toEqual({ url: "https://example.com" });
        expect(parseWebFetchCommand("hello")).toBeNull();
        expect(parseWebStatusCommand("@web-status")).toEqual({ action: "status" });
        expect(parseWebStatusCommand("@web-search foo")).toBeNull();
    });
});

describe("websearch settings", () => {
    test("enabled defaults to true, off values disable", () => {
        expect(isWebSearchEnabled({})).toBe(true);
        expect(isWebSearchEnabled({ websearch_enabled: false })).toBe(false);
        expect(isWebSearchEnabled({ websearch_enabled: "off" })).toBe(false);
        expect(isWebSearchEnabled({ websearch_enabled: "on" })).toBe(true);
    });

    test("provider normalization", () => {
        expect(resolveWebSearchProvider(undefined, {})).toBe("auto");
        expect(resolveWebSearchProvider("brave", {})).toBe("brave");
        expect(resolveWebSearchProvider("ddg", {})).toBe("duckduckgo");
        expect(resolveWebSearchProvider("tavily", {})).toBe("tavily");
        expect(resolveWebSearchProvider("gemini", {})).toBe("google-ai");
        expect(resolveWebSearchProvider("google", {})).toBe("google-ai");
        expect(resolveWebSearchProvider("google-ai", {})).toBe("google-ai");
        expect(resolveWebSearchProvider("live-gemini", {})).toBe("google-ai");
        expect(resolveWebSearchProvider(undefined, { websearch_provider: "brave" })).toBe("brave");
    });

    test("limit clamps to 1-10", () => {
        expect(resolveWebSearchLimit(undefined, {})).toBe(5);
        expect(resolveWebSearchLimit(3, {})).toBe(3);
        expect(resolveWebSearchLimit(99, {})).toBe(10);
        expect(resolveWebSearchLimit("bad", {})).toBe(5);
    });

    test("timeout clamps", () => {
        expect(resolveWebSearchTimeoutMs({})).toBe(12000);
        expect(resolveWebSearchTimeoutMs({ websearch_timeout_ms: "bad" })).toBe(12000);
        expect(resolveWebSearchTimeoutMs({ websearch_timeout_ms: 99999999 })).toBe(60000);
    });

    test("status reflects keys", () => {
        const st = getWebStatus({ brave_api_key: "x" });
        expect(st.brave).toBe(true);
        expect(st.tavily).toBe(false);
        expect(st.duckduckgo).toBe(true);
        expect(st.googleAi).toBe(true);
        expect(st.gemini).toBe(false);
        expect(getWebStatus({ gemini_api_key: "g" }).gemini).toBe(true);
        expect(formatWebStatus({})).toContain("@live-web");
        expect(formatWebStatus({})).toContain("@live-gemini");
        expect(getGeminiApiKey({ gemini_api_key: "g" })).toBe("g");
        expect(isGeminiSearchConfigured({ gemini_api_key: "g" })).toBe(true);
        expect(isGeminiSearchConfigured({})).toBe(false);
        expect(getGeminiSearchModel({}, undefined)).toBe("gemini-2.5-flash");
        expect(getGeminiSearchModel({ gemini_search_model: "custom" })).toBe("custom");
    });
});

describe("websearch html helpers", () => {
    test("decodeHtmlEntities handles named/numeric refs", () => {
        expect(decodeHtmlEntities("a &amp; b &#65; &#x42; &hellip;")).toBe("a & b A B …");
    });

    test("stripHtml removes scripts and tags", () => {
        const out = stripHtml('<html><head><title>T</title><script>var x=1;</script></head><body><p>Hello <b>world</b></p></body></html>');
        expect(out).toContain("Hello world");
        expect(out).not.toContain("var x");
        expect(out).not.toContain("<p>");
    });

    test("unwrapDuckHref decodes uddg redirects", () => {
        expect(unwrapDuckHref("//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&rut=x")).toBe("https://example.com/a");
        expect(unwrapDuckHref("https://example.com/plain")).toBe("https://example.com/plain");
    });

    test("unwrapGoogleHref decodes /url redirects", () => {
        expect(unwrapGoogleHref("/url?q=https://example.com/a&sa=U&ved=x")).toBe("https://example.com/a");
        expect(unwrapGoogleHref("https://example.com/plain")).toBe("https://example.com/plain");
    });

    test("parseGoogleHtmlResults extracts outbound links", () => {
        const html = `
            <a href="/url?q=https://example.com/1&sa=U"><h3>First Result Title Here</h3></a>
            <a href="https://example.com/2"><h3>Second Result Title Longer</h3></a>
            <a href="https://www.google.com/search?q=x">Google internal link here</a>`;
        const res = parseGoogleHtmlResults(html, 5);
        expect(res.length).toBe(2);
        expect(res[0]).toMatchObject({ title: "First Result Title Here", url: "https://example.com/1" });
        expect(res[1].url).toBe("https://example.com/2");
    });

    test("parseGoogleAiAnswer returns empty on JS challenge", () => {
        expect(parseGoogleAiAnswer("<html>enablejs challenge</html>")).toBe("");
        expect(parseGoogleAiAnswer("")).toBe("");
    });

    test("parseDuckHtmlResults pairs titles with snippets", () => {
        const html = `
            <a rel="nofollow" class="result__a" href="https://example.com/1">First <b>Result</b></a>
            <a class="result__snippet" href="x">first snippet text</a>
            <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2F2&rut=y">Second</a>
            <div class="result__snippet">second snippet</div>`;
        const res = parseDuckHtmlResults(html, 5);
        expect(res.length).toBe(2);
        expect(res[0]).toMatchObject({ title: "First Result", url: "https://example.com/1", snippet: "first snippet text" });
        expect(res[1].url).toBe("https://example.com/2");
    });

    test("parseDuckInstantAnswer flattens topics", () => {
        const data = {
            Heading: "Cat",
            AbstractText: "A small domesticated carnivore.",
            AbstractURL: "https://duckduckgo.com/cat",
            RelatedTopics: [
                { FirstURL: "https://example.com/a", Text: "A - alpha topic" },
                { Name: "Group", Topics: [{ FirstURL: "https://example.com/b", Text: "Bravo topic" }] },
            ],
        };
        const res = parseDuckInstantAnswer(data);
        expect(res[0].snippet).toContain("domesticated");
        expect(res.map((r) => r.url)).toContain("https://example.com/a");
        expect(res.map((r) => r.url)).toContain("https://example.com/b");
    });
});

function mockFetch(routes) {
    return async (url, _opts) => {
        const u = String(url);
        for (const [match, payload] of routes) {
            if (u.includes(match)) {
                if (payload instanceof Error) throw payload;
                if (typeof payload === "string") {
                    return { ok: true, headers: { get: () => "text/html" }, text: async () => payload, json: async () => { throw new Error("not json"); } };
                }
                return { ok: true, headers: { get: () => "application/json" }, text: async () => JSON.stringify(payload), json: async () => payload };
            }
        }
        return { ok: false, status: 404, text: async () => "not found" };
    };
}

const DDG_HTML = `
    <a rel="nofollow" class="result__a" href="https://example.com/1">Example One</a>
    <a class="result__snippet" href="x">snippet one</a>`;

describe("websearch engines (mocked fetch)", () => {
    test("searchDuckDuckGo merges instant answer + html", async () => {
        const fetchFn = mockFetch([
            ["html.duckduckgo.com", DDG_HTML],
            ["api.duckduckgo.com", { Heading: "Q", AbstractText: "abstract here", AbstractURL: "https://duckduckgo.com/q", RelatedTopics: [] }],
        ]);
        const res = await searchDuckDuckGo("test query", {}, fetchFn);
        expect(res.success).toBe(true);
        expect(res.provider).toBe("duckduckgo");
        expect(res.results.length).toBeGreaterThanOrEqual(2);
        expect(res.results[0].snippet).toContain("abstract");
    });

    test("searchDuckDuckGo fails gracefully when both fail", async () => {
        const fetchFn = mockFetch([["duckduckgo", new Error("network down")]]);
        const res = await searchDuckDuckGo("q", {}, fetchFn);
        expect(res.success).toBe(false);
        expect(res.error).toContain("DuckDuckGo");
    });

    test("searchBrave needs a key and parses results", async () => {
        const noKey = await searchBrave("q", {}, mockFetch([]));
        expect(noKey.success).toBe(false);
        expect(noKey.error).toMatch(/Brave API key/);
        const ok = await searchBrave("q", { brave_api_key: "k" }, mockFetch([
            ["api.search.brave.com", { web: { results: [{ title: "T", url: "https://t.example", description: "d" }] } }],
        ]));
        expect(ok.success).toBe(true);
        expect(ok.results[0].url).toBe("https://t.example");
    });

    test("searchTavily needs a key and parses results", async () => {
        const noKey = await searchTavily("q", {}, mockFetch([]));
        expect(noKey.success).toBe(false);
        const ok = await searchTavily("q", { tavily_api_key: "k" }, mockFetch([
            ["api.tavily.com", { results: [{ title: "T", url: "https://t.example", content: "c" }] }],
        ]));
        expect(ok.success).toBe(true);
        expect(ok.results[0].snippet).toBe("c");
    });

    test("searchWeb auto prefers brave, falls back to ddg", async () => {
        const fetchFn = mockFetch([
            ["api.search.brave.com", new Error("brave down")],
            ["html.duckduckgo.com", DDG_HTML],
            ["api.duckduckgo.com", { RelatedTopics: [] }],
        ]);
        const res = await searchWeb("q", { brave_api_key: "k" }, {}, fetchFn);
        expect(res.success).toBe(true);
        expect(res.provider).toBe("duckduckgo");
        expect(res.fallback).toBe(true);
        expect(res.engineError).toMatch(/brave down/i);
    });

    test("searchWeb rejects empty queries", async () => {
        const res = await searchWeb("   ", {}, {}, mockFetch([]));
        expect(res.success).toBe(false);
    });

    test("searchGeminiWithGrounding needs a key and parses chunks", async () => {
        const noKey = await searchGeminiWithGrounding("q", {}, mockFetch([]));
        expect(noKey.success).toBe(false);
        expect(noKey.error).toMatch(/Gemini API key/);
        const ok = await searchGeminiWithGrounding("q", { gemini_api_key: "k" }, mockFetch([
            ["generativelanguage.googleapis.com", {
                candidates: [{
                    content: { parts: [{ text: "Grounded answer here. " }] },
                    groundingMetadata: { groundingChunks: [{ web: { uri: "https://g.example/a", title: "A title" } }] },
                }],
            }],
        ]));
        expect(ok.success).toBe(true);
        expect(ok.provider).toBe("google-ai");
        expect(ok.answer).toContain("Grounded");
        expect(ok.results[0].url).toBe("https://g.example/a");
    });

    test("searchGoogleScrape parses classic links", async () => {
        const html = `<a href="/url?q=https://example.com/1&sa=U"><h3>Example Link Title Here</h3></a>`;
        const res = await searchGoogleScrape("q", {}, mockFetch([["google.com/search", html]]));
        expect(res.success).toBe(true);
        expect(res.provider).toBe("google-ai");
        expect(res.results[0].url).toBe("https://example.com/1");
    });

    test("searchGoogleAi prefers grounding, falls back to scrape", async () => {
        const grounded = await searchGoogleAi("q", { gemini_api_key: "k" }, mockFetch([
            ["generativelanguage.googleapis.com", {
                candidates: [{
                    content: { parts: [{ text: "Answer." }] },
                    groundingMetadata: { groundingChunks: [{ web: { uri: "https://g.example/x", title: "X" } }] },
                }],
            }],
        ]));
        expect(grounded.success).toBe(true);
        expect(grounded.provider).toBe("google-ai");
        expect(grounded.answer).toContain("Answer");
    });

    test("searchWeb google-ai falls back to duckduckgo", async () => {
        const fetchFn = mockFetch([
            ["google.com/search", "<html>enablejs</html>"],
            ["html.duckduckgo.com", DDG_HTML],
            ["api.duckduckgo.com", { RelatedTopics: [] }],
        ]);
        const res = await searchWeb("q", {}, { provider: "google-ai" }, fetchFn);
        expect(res.success).toBe(true);
        expect(res.provider).toBe("duckduckgo");
        expect(res.fallback).toBe(true);
    });
});

describe("websearch page fetch (mocked)", () => {
    test("fetchPageText strips to text", async () => {
        const fetchFn = mockFetch([
            ["example.com", "<html><head><title>My Page</title></head><body><p>Hello fetch</p></body></html>"],
        ]);
        const res = await fetchPageText("https://example.com/a", {}, fetchFn);
        expect(res.success).toBe(true);
        expect(res.title).toBe("My Page");
        expect(res.text).toContain("Hello fetch");
    });

    test("fetchPageText refuses non-http schemes and bad urls", async () => {
        expect((await fetchPageText("file:///etc/passwd", {}, mockFetch([]))).success).toBe(false);
        expect((await fetchPageText("not a url", {}, mockFetch([]))).success).toBe(false);
    });
});

describe("websearch formatting + chat integration", () => {
    const good = {
        success: true, provider: "duckduckgo", query: "btc",
        results: [
            { title: "BTC price", url: "https://example.com/btc", snippet: "100k" },
            { title: "More", url: "https://example.com/more", snippet: "details" },
        ],
    };

    test("formatWebResults lists sources", () => {
        const out = formatWebResults(good);
        expect(out).toContain("BTC price");
        expect(out).toContain("https://example.com/btc");
        expect(formatWebResults({ success: false, error: "boom" })).toContain("boom");
    });

    test("formatWebResults renders Google AI answers", () => {
        const geminiRes = {
            success: true, provider: "google-ai", query: "btc", answer: "BTC is up.",
            results: [{ title: "BTC price", url: "https://example.com/btc", snippet: "100k" }],
        };
        const out = formatWebResults(geminiRes);
        expect(out).toContain("Google AI Mode");
        expect(out).toContain("BTC is up.");
        const block = buildWebSystemBlock(geminiRes);
        expect(block).toContain("Google AI Mode");
        expect(block).toContain("BTC is up.");
    });

    test("buildWebSystemBlock instructs citation", () => {
        const block = buildWebSystemBlock(good);
        expect(block).toContain("Live Web Search");
        expect(block).toContain("[1]");
        expect(buildWebSystemBlock({ success: false })).toBe("");
    });

    test("runWebSearchForPrompt triggers inline and respects disabled", async () => {
        const fetchFn = mockFetch([
            ["html.duckduckgo.com", DDG_HTML],
            ["api.duckduckgo.com", { RelatedTopics: [] }],
        ]);
        const hit = await runWebSearchForPrompt("btc price @live-web", {}, fetchFn);
        expect(hit.triggered).toBe(true);
        expect(hit.query).toBe("btc price");
        expect(hit.block).toContain("Live Web Search");
        expect(await runWebSearchForPrompt("plain chat", {}, fetchFn)).toEqual({ triggered: false });
        expect(await runWebSearchForPrompt("btc price @web", {}, fetchFn)).toEqual({ triggered: false });
        expect(await runWebSearchForPrompt("btc @live-web", { websearch_enabled: false }, fetchFn)).toEqual({ triggered: false });
        expect(await runWebSearchForPrompt("@live-web", {}, fetchFn)).toEqual({ triggered: false, reason: "usage" });
    });

    test("runWebSearchForPrompt triggers @live-gemini inline + explicit", async () => {
        const fetchFn = mockFetch([
            ["generativelanguage.googleapis.com", {
                candidates: [{
                    content: { parts: [{ text: "Gemini says hi. " }] },
                    groundingMetadata: { groundingChunks: [{ web: { uri: "https://g.example/hi", title: "Hi" } }] },
                }],
            }],
        ]);
        const hit = await runWebSearchForPrompt("explain cats @live-gemini", { gemini_api_key: "k" }, fetchFn);
        expect(hit.triggered).toBe(true);
        expect(hit.query).toBe("explain cats");
        expect(hit.searchRes.provider).toBe("google-ai");
        expect(hit.block).toContain("Google AI Mode");
        const explicit = await runWebSearchForPrompt("@live-gemini explain dogs", { gemini_api_key: "k" }, fetchFn);
        expect(explicit.triggered).toBe(true);
        expect(explicit.searchRes.provider).toBe("google-ai");
        expect(await runWebSearchForPrompt("@live-gemini", {}, fetchFn)).toEqual({ triggered: false, reason: "usage" });
        expect(await runWebSearchForPrompt("explain cats @live-gemini", { websearch_enabled: false }, fetchFn)).toEqual({ triggered: false });
    });

    test("runLiveGeminiForPrompt only fires for gemini token", async () => {
        const fetchFn = mockFetch([
            ["generativelanguage.googleapis.com", {
                candidates: [{
                    content: { parts: [{ text: "Answer. " }] },
                    groundingMetadata: { groundingChunks: [{ web: { uri: "https://g.example/a", title: "A" } }] },
                }],
            }],
            ["html.duckduckgo.com", DDG_HTML],
            ["api.duckduckgo.com", { RelatedTopics: [] }],
        ]);
        const hit = await runLiveGeminiForPrompt("explain cats @live-gemini", { gemini_api_key: "k" }, fetchFn);
        expect(hit.triggered).toBe(true);
        expect(hit.searchRes.provider).toBe("google-ai");
        expect(await runLiveGeminiForPrompt("latest BTC @live-web", {}, fetchFn)).toEqual({ triggered: false });
        expect(await runLiveGeminiForPrompt("plain chat", {}, fetchFn)).toEqual({ triggered: false });
    });
});
