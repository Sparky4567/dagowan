import { describe, expect, test } from "bun:test";
import {
    FACTCHECK_DEFAULT_LIMIT,
    buildGeminiFactCheckPrompt,
    checkClaimWithGemini,
    checkFactClaim,
    formatFactCheckResult,
    getFactCheckStatus,
    getGeminiApiKey,
    getGeminiModel,
    getSemanticScholarApiKey,
    isGeminiConfigured,
    isSemanticScholarConfigured,
    parseFactCheckInput,
    resolveFactCheckLimit,
    resolveFactCheckSource,
    searchPapers,
} from "./factcheck_api.js";

function jsonResponse(data, ok = true, status = 200) {
    return { ok, status, json: async () => data, text: async () => JSON.stringify(data) };
}

const samplePaper = {
    paperId: "abc123",
    title: "Sleep deprivation and Alzheimer risk",
    abstract: "We study sleep and Alzheimer disease risk in a cohort.",
    year: 2023,
    citationCount: 42,
    externalIds: { DOI: "10.1000/xyz123" },
    openAccessPdf: { url: "https://example.com/paper.pdf" },
};

describe("semantic scholar fact-check", () => {
    test("resolves api key (settings win, then env) and limit clamping", () => {
        const prevKey = process.env.SEMANTIC_SCHOLAR_API_KEY;
        const prevLimit = process.env.FACTCHECK_MAX_RESULTS;
        try {
            delete process.env.SEMANTIC_SCHOLAR_API_KEY;
            delete process.env.FACTCHECK_MAX_RESULTS;
            expect(getSemanticScholarApiKey({})).toBe("");
            expect(isSemanticScholarConfigured({})).toBe(false);
            expect(getSemanticScholarApiKey({ semantic_scholar_api_key: "k" })).toBe("k");
            expect(isSemanticScholarConfigured({ semantic_scholar_api_key: "k" })).toBe(true);
            expect(resolveFactCheckLimit(undefined, {})).toBe(FACTCHECK_DEFAULT_LIMIT);
            expect(resolveFactCheckLimit(2, {})).toBe(2);
            expect(resolveFactCheckLimit(0, {})).toBe(FACTCHECK_DEFAULT_LIMIT);
            expect(resolveFactCheckLimit(99, {})).toBe(10);
            expect(resolveFactCheckLimit(undefined, { factcheck_max_results: 5 })).toBe(5);
            process.env.SEMANTIC_SCHOLAR_API_KEY = "env-key";
            expect(getSemanticScholarApiKey({})).toBe("env-key");
            expect(getSemanticScholarApiKey({ semantic_scholar_api_key: "set-key" })).toBe("set-key");
        } finally {
            if (prevKey === undefined) delete process.env.SEMANTIC_SCHOLAR_API_KEY;
            else process.env.SEMANTIC_SCHOLAR_API_KEY = prevKey;
            if (prevLimit === undefined) delete process.env.FACTCHECK_MAX_RESULTS;
            else process.env.FACTCHECK_MAX_RESULTS = prevLimit;
        }
    });

    test("@fact-check parser handles aliases and --limit", () => {
        expect(parseFactCheckInput("@fact-check Does sleep deprivation increase risk of Alzheimer's?")).toEqual({
            claim: "Does sleep deprivation increase risk of Alzheimer's?",
            maxResults: FACTCHECK_DEFAULT_LIMIT,
            source: "auto",
            model: "gemini-2.5-flash",
            verdict: true,
        });
        expect(parseFactCheckInput("@factcheck sleep and alzheimer --limit 2")).toEqual({
            claim: "sleep and alzheimer",
            maxResults: 2,
            source: "auto",
            model: "gemini-2.5-flash",
            verdict: true,
        });
        expect(parseFactCheckInput("@fact_check sleep --max 5")).toEqual({
            claim: "sleep",
            maxResults: 5,
            source: "auto",
            model: "gemini-2.5-flash",
            verdict: true,
        });
        expect(parseFactCheckInput("@verify sleep")).toEqual({
            claim: "sleep",
            maxResults: FACTCHECK_DEFAULT_LIMIT,
            source: "auto",
            model: "gemini-2.5-flash",
            verdict: true,
        });
        expect(parseFactCheckInput("@fact-check sleep --source gemini")).toMatchObject({
            claim: "sleep",
            source: "gemini",
        });
        expect(parseFactCheckInput("@fact-check sleep --source papers --no-verdict")).toMatchObject({
            claim: "sleep",
            source: "papers",
            verdict: false,
        });
        expect(parseFactCheckInput("@fact-check sleep --model gemini-2.0-flash")).toMatchObject({
            claim: "sleep",
            model: "gemini-2.0-flash",
        });
        expect(parseFactCheckInput("@fact-check")).toEqual({
            claim: "",
            maxResults: FACTCHECK_DEFAULT_LIMIT,
            source: "auto",
            model: "gemini-2.5-flash",
            verdict: true,
        });
        expect(parseFactCheckInput("@play lofi")).toBeNull();
        expect(parseFactCheckInput("just chatting")).toBeNull();
    });

    test("searchPapers maps Semantic Scholar fields like the python version", async () => {
        const calls = [];
        const fetchFn = async (url, opts) => {
            calls.push({ url: String(url), opts });
            return jsonResponse({ data: [samplePaper] });
        };
        const res = await searchPapers("sleep deprivation alzheimer", {}, fetchFn);
        expect(res.success).toBe(true);
        expect(res.source).toBe("semantic-scholar");
        expect(res.papers).toHaveLength(1);
        expect(res.papers[0]).toEqual({
            title: "Sleep deprivation and Alzheimer risk",
            year: 2023,
            citations: 42,
            abstract: "We study sleep and Alzheimer disease risk in a cohort.",
            doi: "10.1000/xyz123",
            pdf_url: "https://example.com/paper.pdf",
            paperId: "abc123",
        });
        expect(calls[0].url).toContain("api.semanticscholar.org/graph/v1/paper/search");
        expect(calls[0].url).toContain("citationCount");
        const missingAbstract = await searchPapers(
            "x",
            {},
            async () => jsonResponse({ data: [{ ...samplePaper, abstract: null, externalIds: {}, openAccessPdf: null }] })
        );
        expect(missingAbstract.papers[0].abstract).toBe("No abstract available.");
        expect(missingAbstract.papers[0].doi).toBeNull();
        expect(missingAbstract.papers[0].pdf_url).toBeNull();
    });

    test("searchPapers sends x-api-key when configured", async () => {
        const calls = [];
        const fetchFn = async (url, opts) => {
            calls.push({ url, opts });
            return jsonResponse({ data: [samplePaper] });
        };
        await searchPapers("sleep", { semantic_scholar_api_key: "secret" }, fetchFn);
        expect(calls[0].opts.headers["x-api-key"]).toBe("secret");
        await searchPapers("sleep", {}, fetchFn);
        expect(calls[1].opts.headers["x-api-key"]).toBeUndefined();
    });

    test("searchPapers reports no-result and network errors", async () => {
        const empty = await searchPapers("zzz qqq", {}, async () => jsonResponse({ data: [] }));
        expect(empty.success).toBe(false);
        expect(empty.error).toMatch(/No papers found/);
        const netErr = await searchPapers(
            "sleep",
            {},
            async () => ({ ok: false, status: 429, text: async () => "rate limit", json: async () => ({}) })
        );
        expect(netErr.success).toBe(false);
        expect(netErr.error).toMatch(/Semantic Scholar error/);
    });

    test("empty input is rejected without touching network", async () => {
        let called = false;
        const fetchFn = async () => {
            called = true;
            return jsonResponse({ data: [] });
        };
        expect((await searchPapers("", {}, fetchFn)).success).toBe(false);
        expect((await checkFactClaim("   ", {}, {}, fetchFn)).success).toBe(false);
        expect(called).toBe(false);
    });

    test("checkFactClaim honors per-call maxResults", async () => {
        const calls = [];
        const fetchFn = async (url) => {
            calls.push(String(url));
            return jsonResponse({ data: [samplePaper] });
        };
        const res = await checkFactClaim("sleep", {}, { maxResults: 2 }, fetchFn);
        expect(res.success).toBe(true);
        expect(calls[0]).toContain("limit=2");
    });

    test("formatter renders papers and errors", () => {
        const out = formatFactCheckResult({
            success: true,
            claim: "Does sleep deprivation increase risk of Alzheimer's?",
            papers: [
                {
                    title: "Sleep deprivation and Alzheimer risk",
                    year: 2023,
                    citations: 42,
                    abstract: "abc ".repeat(100),
                    doi: "10.1000/xyz123",
                    pdf_url: "https://example.com/paper.pdf",
                },
            ],
        });
        expect(out).toContain("Paper #1");
        expect(out).toContain("Citations: 42");
        expect(out).toContain("https://doi.org/10.1000/xyz123");
        expect(out).toContain("Semantic Scholar");
        expect(formatFactCheckResult({ success: false, error: "boom" })).toContain("boom");
        expect(formatFactCheckResult({ success: false, error: "boom" })).toContain("Fact-check error");
    });

    test("gemini key / source / model resolution", () => {
        const prevKey = process.env.GEMINI_API_KEY;
        const prevSource = process.env.FACTCHECK_SOURCE;
        const prevModel = process.env.FACTCHECK_GEMINI_MODEL;
        try {
            delete process.env.GEMINI_API_KEY;
            delete process.env.FACTCHECK_SOURCE;
            delete process.env.FACTCHECK_GEMINI_MODEL;
            expect(getGeminiApiKey({})).toBe("");
            expect(isGeminiConfigured({})).toBe(false);
            expect(getGeminiApiKey({ gemini_api_key: "g-key" })).toBe("g-key");
            expect(isGeminiConfigured({ gemini_api_key: "g-key" })).toBe(true);
            process.env.GEMINI_API_KEY = "env-gemini";
            expect(getGeminiApiKey({})).toBe("env-gemini");
            expect(resolveFactCheckSource(undefined, {})).toBe("auto");
            expect(resolveFactCheckSource("gemini", {})).toBe("gemini");
            expect(resolveFactCheckSource("papers", {})).toBe("papers");
            expect(resolveFactCheckSource("semantic-scholar", {})).toBe("papers");
            expect(resolveFactCheckSource(undefined, { factcheck_source: "gemini" })).toBe("gemini");
            expect(getGeminiModel({}, undefined)).toBe("gemini-2.5-flash");
            expect(getGeminiModel({}, "gemini-2.0-flash")).toBe("gemini-2.0-flash");
            expect(getGeminiModel({ factcheck_gemini_model: "custom-model" })).toBe("custom-model");
            expect(getFactCheckStatus({ gemini_api_key: "k" }).gemini).toBe(true);
            delete process.env.GEMINI_API_KEY;
            expect(getFactCheckStatus({}).gemini).toBe(false);
            expect(buildGeminiFactCheckPrompt("coffee cures baldness", [])).toContain("coffee cures baldness");
        } finally {
            if (prevKey === undefined) delete process.env.GEMINI_API_KEY;
            else process.env.GEMINI_API_KEY = prevKey;
            if (prevSource === undefined) delete process.env.FACTCHECK_SOURCE;
            else process.env.FACTCHECK_SOURCE = prevSource;
            if (prevModel === undefined) delete process.env.FACTCHECK_GEMINI_MODEL;
            else process.env.FACTCHECK_GEMINI_MODEL = prevModel;
        }
    });

    test("checkClaimWithGemini posts to generateContent and returns verdict", async () => {
        const calls = [];
        const fetchFn = async (url, opts) => {
            calls.push({ url: String(url), opts });
            return jsonResponse({
                candidates: [{ content: { parts: [{ text: "Verdict: MIXED\nConfidence: 60%\nExplanation: evidence is mixed." }] } }],
            });
        };
        const res = await checkClaimWithGemini("sleep cures everything", [], { gemini_api_key: "g-key" }, "gemini-2.5-flash", fetchFn);
        expect(res.success).toBe(true);
        expect(res.verdict).toContain("Verdict: MIXED");
        expect(res.model).toBe("gemini-2.5-flash");
        expect(calls[0].url).toContain("generativelanguage.googleapis.com");
        expect(calls[0].url).toContain("gemini-2.5-flash");
        const missing = await checkClaimWithGemini("x", [], {}, undefined, fetchFn);
        expect(missing.success).toBe(false);
        expect(missing.error).toMatch(/Gemini API key/);
    });

    test("checkFactClaim auto adds gemini verdict on top of papers", async () => {
        const fetchFn = async (url, opts) => {
            if (String(url).includes("semanticscholar")) return jsonResponse({ data: [samplePaper] });
            return jsonResponse({
                candidates: [{ content: { parts: [{ text: "Verdict: SUPPORTED\nConfidence: 80%\nExplanation: papers support it." }] } }],
            });
        };
        const res = await checkFactClaim("sleep", { gemini_api_key: "g-key" }, { source: "auto" }, fetchFn);
        expect(res.success).toBe(true);
        expect(res.papers).toHaveLength(1);
        expect(res.verdict).toContain("SUPPORTED");
        expect(res.source).toBe("semantic-scholar+gemini");
        const out = formatFactCheckResult(res);
        expect(out).toContain("Gemini verdict");
        expect(out).toContain("SUPPORTED");
    });

    test("checkFactClaim auto falls back to gemini when papers are empty", async () => {
        const fetchFn = async (url) => {
            if (String(url).includes("semanticscholar")) return jsonResponse({ data: [] });
            return jsonResponse({
                candidates: [{ content: { parts: [{ text: "Verdict: UNVERIFIABLE\nConfidence: 10%\nExplanation: no evidence." }] } }],
            });
        };
        const res = await checkFactClaim("obscure claim xyz", { gemini_api_key: "g-key" }, { source: "auto" }, fetchFn);
        expect(res.success).toBe(true);
        expect(res.papers).toHaveLength(0);
        expect(res.fallback).toBe(true);
        expect(res.verdict).toContain("UNVERIFIABLE");
    });

    test("checkFactClaim papers-only skips gemini even when key is set", async () => {
        let geminiCalled = false;
        const fetchFn = async (url) => {
            if (String(url).includes("generativelanguage")) {
                geminiCalled = true;
                return jsonResponse({ candidates: [] });
            }
            return jsonResponse({ data: [samplePaper] });
        };
        const res = await checkFactClaim("sleep", { gemini_api_key: "g-key" }, { source: "papers" }, fetchFn);
        expect(res.success).toBe(true);
        expect(res.verdict).toBeUndefined();
        expect(geminiCalled).toBe(false);
    });

    test("checkFactClaim gemini-only requires a key", async () => {
        let called = false;
        const fetchFn = async () => {
            called = true;
            return jsonResponse({ candidates: [] });
        };
        const noKey = await checkFactClaim("sleep", {}, { source: "gemini" }, fetchFn);
        expect(noKey.success).toBe(false);
        expect(noKey.error).toMatch(/Gemini API key/);
        expect(called).toBe(false);
    });
});
