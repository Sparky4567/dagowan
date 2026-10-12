// ---------------------------------------------------------------------------
// Fact-checking for @fact-check / @factcheck (@verify).
//
// Two engines, same convention as @play / @blog (API-first, auto fallback):
//   1. Papers (Semantic Scholar Graph API paper/search, fields
//      title,abstract,year,citationCount,openAccessPdf,externalIds).
//      No key required (anonymous rate limits apply); an API key raises
//      limits via the `x-api-key` header when configured.
//   2. Gemini verdict (Google Generative Language API generateContent).
//      Requires GEMINI_API_KEY / settings.gemini_api_key. Used to judge the
//      claim against the retrieved abstracts, or standalone when papers
//      return nothing / `--source gemini` is passed.
//
// Source selection (`auto` default):
//   @fact-check <claim> [--limit N] [--source auto|papers|gemini]
//               [--model <gemini-model>] [--no-verdict]
//   FACTCHECK_SOURCE / settings.factcheck_source (default "auto")
//   FACTCHECK_GEMINI_MODEL / settings.factcheck_gemini_model
//      (default "gemini-2.5-flash")
//
// No Chromium / browser fallback — these are pure data + LLM lookups.
//
// Env / settings (settings win after env — same convention as providers.js):
//   SEMANTIC_SCHOLAR_API_KEY (or settings.semantic_scholar_api_key)
//   GEMINI_API_KEY (or settings.gemini_api_key, shared with the chat model)
//   FACTCHECK_MAX_RESULTS / settings.factcheck_max_results (default 3, 1–10)
//   FACTCHECK_SOURCE / settings.factcheck_source (default "auto")
//   FACTCHECK_GEMINI_MODEL / settings.factcheck_gemini_model
// ---------------------------------------------------------------------------

export const SEMANTIC_SCHOLAR_SEARCH_URL =
    "https://api.semanticscholar.org/graph/v1/paper/search";
export const FACTCHECK_DEFAULT_LIMIT = 3;
export const FACTCHECK_MAX_LIMIT = 10;
export const FACTCHECK_FIELDS =
    "title,abstract,year,citationCount,openAccessPdf,externalIds";
export const FACTCHECK_DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";
export const FACTCHECK_SOURCES = ["auto", "papers", "gemini"];

export function getSemanticScholarApiKey(settings = {}) {
    return (
        (settings && settings.semantic_scholar_api_key) ||
        process.env.SEMANTIC_SCHOLAR_API_KEY ||
        ""
    );
}

export function isSemanticScholarConfigured(settings = {}) {
    return Boolean(getSemanticScholarApiKey(settings));
}

export function getGeminiApiKey(settings = {}) {
    return (
        (settings && settings.gemini_api_key) ||
        process.env.GEMINI_API_KEY ||
        ""
    );
}

export function isGeminiConfigured(settings = {}) {
    return Boolean(getGeminiApiKey(settings));
}

export function getGeminiModel(settings = {}, override) {
    const fromOverride = String(override || "").trim();
    if (fromOverride) return fromOverride;
    const fromSettings = String(
        (settings && settings.factcheck_gemini_model) || ""
    ).trim();
    if (fromSettings) return fromSettings;
    const fromEnv = String(process.env.FACTCHECK_GEMINI_MODEL || "").trim();
    if (fromEnv) return fromEnv;
    return FACTCHECK_DEFAULT_GEMINI_MODEL;
}

/** Normalize a fact-check source: "auto" | "papers" | "gemini". */
export function resolveFactCheckSource(value, settings = {}) {
    const raw = String(
        value !== undefined && value !== null && value !== ""
            ? value
            : (settings && settings.factcheck_source) ||
                  process.env.FACTCHECK_SOURCE ||
                  "auto"
    )
        .trim()
        .toLowerCase()
        .replace(/[\s_]+/g, "-");
    if (["papers", "paper", "scholar", "semantic-scholar", "semanticscholar", "s2"].includes(raw))
        return "papers";
    if (["gemini", "google", "llm", "ai", "verdict"].includes(raw)) return "gemini";
    return "auto";
}

/** Engine status for @api-keys (mirrors getPlayStatus / getBlogStatus). */
export function getFactCheckStatus(settings = {}) {
    const gemini = isGeminiConfigured(settings);
    return {
        source: resolveFactCheckSource(undefined, settings),
        papers: true, // Semantic Scholar anonymous access always works
        papersApi: isSemanticScholarConfigured(settings),
        gemini,
        geminiModel: getGeminiModel(settings),
    };
}

export function resolveFactCheckLimit(value, settings = {}) {
    const fromSettings = Number(
        settings ? settings.factcheck_max_results : NaN
    );
    const fromEnv = Number(process.env.FACTCHECK_MAX_RESULTS || NaN);
    let n = Number(value);
    if (!Number.isFinite(n) || n <= 0) {
        if (Number.isFinite(fromSettings) && fromSettings > 0) n = fromSettings;
        else if (Number.isFinite(fromEnv) && fromEnv > 0) n = fromEnv;
        else n = FACTCHECK_DEFAULT_LIMIT;
    }
    n = Math.floor(n);
    if (n < 1) return 1;
    if (n > FACTCHECK_MAX_LIMIT) return FACTCHECK_MAX_LIMIT;
    return n;
}

function httpError(status, bodyText) {
    const detail = String(bodyText || "").slice(0, 300);
    return new Error(`HTTP ${status}${detail ? `: ${detail}` : ""}`);
}

async function fetchJson(url, options, fetchFn) {
    const run = fetchFn || fetch;
    let res;
    if (fetchFn) {
        res = await fetchFn(url, options);
    } else if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) {
        res = await run(url, {
            ...options,
            signal: AbortSignal.timeout(10000),
        });
    } else {
        res = await run(url, options);
    }
    if (!res.ok) {
        let body = "";
        try {
            body = await res.text();
        } catch {}
        throw httpError(res.status, body);
    }
    return res.json();
}

/**
 * Shared "@fact-check <claim> [--limit N] [--source auto|papers|gemini]
 * [--model <gemini-model>] [--no-verdict]" parser used by the CLI,
 * Telegram and WhatsApp routers so all surfaces behave identically.
 * Returns null when `text` is not a fact-check command, otherwise
 * `{ claim, maxResults, source, model, verdict }`
 * (`claim === ""` means usage help shown).
 */
export function parseFactCheckInput(text, settings = {}) {
    const rawInput = String(text || "").trim();
    const norm = rawInput.startsWith("@") ? "/" + rawInput.slice(1) : rawInput;
    const low = norm.toLowerCase();
    const head = low.split(/\s/, 1)[0];
    if (
        head !== "/fact-check" &&
        head !== "/factcheck" &&
        head !== "/fact_check" &&
        head !== "/check-fact" &&
        head !== "/verify"
    ) {
        return null;
    }
    let body = norm.slice(head.length).trim();
    let maxResults = null;
    const limitMatch = body.match(
        /\s--(?:limit|max|max-results|max_results|n)(?:\s+|=)\s*(\d+)/i
    );
    if (limitMatch) maxResults = Number(limitMatch[1]);
    let source = null;
    const sourceMatch = body.match(/\s--(?:source|engine|via)(?:\s+|=)\s*([^\s]+)/i);
    if (sourceMatch) source = sourceMatch[1];
    let model = null;
    const modelMatch = body.match(/\s--(?:model|gemini-model)(?:\s+|=)\s*([^\s]+)/i);
    if (modelMatch) model = modelMatch[1];
    const noVerdict = /\s--no-verdict(?:\s|$)/i.test(` ${body} `);
    const claim = body
        .replace(/\s--(?:limit|max|max-results|max_results|n)(?:\s+|=)\s*\d+/gi, " ")
        .replace(/\s--(?:source|engine|via)(?:\s+|=)\s*[^\s]+/gi, " ")
        .replace(/\s--(?:model|gemini-model)(?:\s+|=)\s*[^\s]+/gi, " ")
        .replace(/\s--no-verdict(?:\s|$)/gi, " ")
        .replace(/\s--verdict(?:\s|$)/gi, " ")
        .replace(/\s--(no-)?show(\s|$)/gi, " ")
        .trim();
    return {
        claim,
        maxResults: resolveFactCheckLimit(maxResults, settings),
        source: resolveFactCheckSource(source, settings),
        model: getGeminiModel(settings, model),
        verdict: !noVerdict,
    };
}

/**
 * Port of the reference Python `check_fact_against_papers`: searches
 * Semantic Scholar for papers related to a claim and extracts titles,
 * abstracts, and citation counts for verification.
 */
export async function searchPapers(claim, settings = {}, fetchFn = fetch) {
    const q = String(claim || "").trim();
    if (!q) {
        return {
            success: false,
            error: "Usage: provide a claim to verify.",
        };
    }
    const limit = resolveFactCheckLimit(
        settings && settings.factcheck_max_results
            ? settings.factcheck_max_results
            : FACTCHECK_DEFAULT_LIMIT,
        settings
    );
    const url =
        `${SEMANTIC_SCHOLAR_SEARCH_URL}?query=${encodeURIComponent(q)}` +
        `&limit=${encodeURIComponent(String(limit))}` +
        `&fields=${encodeURIComponent(FACTCHECK_FIELDS)}`;
    const key = getSemanticScholarApiKey(settings);
    const headers = key ? { "x-api-key": key } : {};
    try {
        const data = await fetchJson(url, { headers }, fetchFn);
        const papers = (Array.isArray(data.data) ? data.data : []).map(
            (paper) => ({
                title: paper ? paper.title : "",
                year: paper ? paper.year : null,
                citations:
                    paper && typeof paper.citationCount === "number"
                        ? paper.citationCount
                        : 0,
                abstract:
                    (paper && paper.abstract) || "No abstract available.",
                doi:
                    (paper &&
                        paper.externalIds &&
                        paper.externalIds.DOI) ||
                    null,
                pdf_url:
                    (paper && paper.openAccessPdf && paper.openAccessPdf.url) ||
                    null,
                paperId: (paper && paper.paperId) || null,
            })
        );
        if (papers.length === 0) {
            return {
                success: false,
                claim: q,
                papers: [],
                source: "semantic-scholar",
                error: `No papers found for "${q}".`,
            };
        }
        return { success: true, claim: q, papers, source: "semantic-scholar" };
    } catch (err) {
        return {
            success: false,
            claim: q,
            papers: [],
            source: "semantic-scholar",
            error: `Semantic Scholar error: ${err.message || String(err)}`,
        };
    }
}

/**
 * Default fact-check entry point. `opts.maxResults` overrides the
 * configured default for this call only; `opts.source` is one of
 * "auto" | "papers" | "gemini"; `opts.model` overrides the Gemini model;
 * `opts.verdict === false` (or `opts.noVerdict`) skips the Gemini verdict.
 *
 * Behavior:
 * - "papers": Semantic Scholar only (legacy behavior, no Gemini call).
 * - "gemini": Gemini verdict only (papers are not required).
 * - "auto" (default): Semantic Scholar first; when a Gemini key is
 *   configured the verdict is added on top. When papers fail or are empty,
 *   falls back to a standalone Gemini verdict instead of an error.
 */
export async function checkFactClaim(claim, settings = {}, opts = {}, fetchFn = fetch) {
    const q = String(claim || "").trim();
    if (!q) {
        return {
            success: false,
            error: "Usage: @fact-check <claim> [--limit N] [--source auto|papers|gemini]",
        };
    }
    const merged = { ...(settings || {}) };
    if (opts && opts.maxResults !== undefined && opts.maxResults !== null) {
        merged.factcheck_max_results = resolveFactCheckLimit(
            opts.maxResults,
            settings
        );
    }
    const source = resolveFactCheckSource(
        opts && opts.source !== undefined ? opts.source : undefined,
        merged
    );
    const model = getGeminiModel(
        merged,
        opts && (opts.model || opts.geminiModel)
    );
    const verdictWanted =
        !opts || (opts.verdict !== false && !opts.noVerdict);

    if (source === "gemini") {
        const key = getGeminiApiKey(merged);
        if (!key) {
            return {
                success: false,
                claim: q,
                papers: [],
                source: "gemini",
                model,
                error: "Gemini API key is not configured. Set it with @set-api-key gemini <key> (or GEMINI_API_KEY) or use --source papers.",
            };
        }
        const judged = await checkClaimWithGemini(q, [], merged, model, fetchFn);
        if (!judged.success) return { ...judged, claim: q, papers: [] };
        return { success: true, claim: q, papers: [], ...judged };
    }

    const papersRes = await searchPapers(q, merged, fetchFn);
    if (source === "papers" || !verdictWanted || !isGeminiConfigured(merged)) {
        return { ...papersRes, source: papersRes.source || "semantic-scholar" };
    }

    // source === "auto" with a Gemini key: judge papers, or fall back to a
    // standalone verdict when papers failed / came back empty.
    if (!papersRes.success || !papersRes.papers || papersRes.papers.length === 0) {
        const judged = await checkClaimWithGemini(
            q,
            [],
            merged,
            model,
            fetchFn
        );
        if (judged.success) {
            return {
                success: true,
                claim: q,
                papers: [],
                ...judged,
                fallback: true,
                papersError: papersRes.error || undefined,
            };
        }
        return {
            ...papersRes,
            verdictError: judged.error || undefined,
        };
    }

    const judged = await checkClaimWithGemini(
        q,
        papersRes.papers,
        merged,
        model,
        fetchFn
    );
    if (judged.success) {
        return {
            ...papersRes,
            source: "semantic-scholar+gemini",
            verdict: judged.verdict,
            model: judged.model,
        };
    }
    return { ...papersRes, verdictError: judged.error || undefined };
}

/** Prompt sent to Gemini: verdict + explanation grounded in the papers. */
export function buildGeminiFactCheckPrompt(claim, papers = []) {
    const evidence = (Array.isArray(papers) ? papers : [])
        .slice(0, 10)
        .map((p, i) => {
            const year = p && p.year ? ` (${p.year})` : "";
            const cites = p && p.citations !== undefined ? ` [cited by ${p.citations}]` : "";
            const abstract = String((p && p.abstract) || "No abstract available.").slice(0, 800);
            return `${i + 1}. "${(p && p.title) || "(untitled)"}"${year}${cites}\n   ${abstract}`;
        })
        .join("\n");
    return (
        `You are a careful fact-checking assistant. Judge the claim below${evidence ? " using ONLY the academic paper evidence provided" : ""}. ` +
        `Reply in this exact shape:\nVerdict: <SUPPORTED | REFUTED | MIXED | UNVERIFIABLE>\nConfidence: <0-100%>\nExplanation: <2-5 sentences citing the evidence by number${evidence ? "" : " or explaining why it cannot be verified"}>\n\n` +
        `Claim: "${claim}"` +
        (evidence ? `\n\nAcademic evidence:\n${evidence}` : `\n\nNo academic paper evidence was found; judge from general knowledge and say UNVERIFIABLE when unsure.`)
    );
}

/**
 * Ask Gemini (Generative Language API) for a verdict on a claim,
 * optionally grounded in Semantic Scholar papers. Pure fetch so tests can
 * inject `fetchFn`; `model` defaults to settings / env / gemini-2.5-flash.
 */
export async function checkClaimWithGemini(claim, papers = [], settings = {}, model, fetchFn = fetch) {
    const q = String(claim || "").trim();
    if (!q) {
        return { success: false, source: "gemini", error: "Usage: provide a claim to verify." };
    }
    const key = getGeminiApiKey(settings);
    if (!key) {
        return {
            success: false,
            source: "gemini",
            error: "Gemini API key is not configured. Set it with @set-api-key gemini <key> (or GEMINI_API_KEY).",
        };
    }
    const useModel = getGeminiModel(settings, model);
    const url =
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(useModel)}` +
        `:generateContent?key=${encodeURIComponent(key)}`;
    const prompt = buildGeminiFactCheckPrompt(q, papers);
    try {
        const data = await fetchJson(
            url,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    contents: [{ role: "user", parts: [{ text: prompt }] }],
                    generationConfig: { temperature: 0.2, maxOutputTokens: 1024 },
                }),
            },
            fetchFn
        );
        const parts =
            (data &&
                data.candidates &&
                data.candidates[0] &&
                data.candidates[0].content &&
                data.candidates[0].content.parts) ||
            [];
        const verdict = parts
            .map((p) => (p && p.text ? p.text : ""))
            .join("")
            .trim();
        if (!verdict) {
            return { success: false, source: "gemini", model: useModel, error: "Gemini returned an empty verdict." };
        }
        return { success: true, claim: q, verdict, source: "gemini", model: useModel };
    } catch (err) {
        return {
            success: false,
            claim: q,
            source: "gemini",
            model: useModel,
            error: `Gemini error: ${err.message || String(err)}`,
        };
    }
}

/** Chat reply for a checkFactClaim result (bridges + CLI). */
export function formatFactCheckResult(res) {
    if (!res || !res.success) {
        return `⚠️ Fact-check error: ${(res && res.error) || "unknown error"}`;
    }
    const papers = Array.isArray(res.papers) ? res.papers : [];
    const lines = [`🔍 Academic literature for: "${res.claim || ""}"`];
    papers.forEach((paper, idx) => {
        const year = paper.year ? ` (${paper.year})` : "";
        lines.push(`\n--- Paper #${idx + 1} ---`);
        lines.push(`Title: ${paper.title || "(untitled)"}${year}`);
        lines.push(`Citations: ${paper.citations ?? 0}`);
        lines.push(
            paper.doi ? `DOI: https://doi.org/${paper.doi}` : "DOI: N/A"
        );
        if (paper.pdf_url) lines.push(`PDF: ${paper.pdf_url}`);
        const snippet = String(paper.abstract || "").slice(0, 250);
        lines.push(`Abstract Snippet: ${snippet}${String(paper.abstract || "").length > 250 ? "..." : ""}`);
    });
    if (res.papersError) lines.push(`\n⚠️ Paper search note: ${res.papersError}`);
    if (res.verdict) {
        lines.push(`\n--- Gemini verdict (${res.model || FACTCHECK_DEFAULT_GEMINI_MODEL}) ---`);
        lines.push(String(res.verdict).trim());
    } else if (res.verdictError) {
        lines.push(`\n⚠️ Gemini verdict unavailable: ${res.verdictError}`);
    }
    const via =
        res.source === "gemini"
            ? "📚 via Gemini (no paper evidence — verify independently)."
            : res.source === "semantic-scholar+gemini"
              ? "📚 via Semantic Scholar + Gemini verdict (verify the claim against the abstracts above)."
              : "📚 via Semantic Scholar (verify the claim against the abstracts above).";
    lines.push(`\n${via}`);
    return lines.join("\n");
}
