/**
 * One-shot worker_threads entry for CPU-bound retrieval scoring.
 *
 * Main thread keeps all DB/file reads (bun:sqlite handles are NOT
 * transferable). It sends plain JSON docs + precomputed helpers; this
 * worker only scores its chunk and posts the result back.
 *
 * Message in: { kind, queryTokens?, queryWords?, docFreq?, totalDocs?, cleanQuery?, docs }
 * Message out: { ok: true, scored } or { ok: false, error }
 */
import { parentPort } from "node:worker_threads";

const STOP_WORDS = new Set([
    "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
    "of", "with", "by", "from", "up", "about", "into", "over", "after",
    "is", "am", "are", "was", "were", "be", "been", "being", "have", "has",
    "had", "do", "does", "did", "can", "could", "shall", "should", "will",
    "would", "it", "its", "what", "which", "who", "whom", "this", "that",
    "these", "those", "tell", "show", "me", "you", "i", "we", "they",
]);

function tokenizeLocal(text) {
    if (!text || typeof text !== "string") return [];
    return text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .split(/\s+/)
        .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
}

function scoreMemoryChunk({ queryTokens, docs, docFreq, totalDocs }) {
    const freq = new Map(Object.entries(docFreq || {}));
    const N = totalDocs || docs.length || 1;
    const out = [];
    for (const mem of docs) {
        const docTokens = Array.from(
            new Set(tokenizeLocal(`${mem.content || ""} ${(mem.tags || []).join(" ")}`))
        );
        let tfIdf = 0;
        const matched = [];
        for (const q of queryTokens) {
            if (docTokens.includes(q)) {
                matched.push(q);
                const df = freq.get(q) || 1;
                tfIdf += Math.log((N + 1) / df) + 1;
            }
        }
        if (matched.length > 0) {
            const importanceBoost = 1 + (mem.importance || 0.5) * 0.5;
            const confidenceBoost = mem.confidence || 1.0;
            const typeBoost =
                mem.type === "correction" ? 1.5
                : mem.type === "project" ? 1.2
                : mem.type === "preference" ? 1.1 : 1.0;
            out.push({ memory: mem, score: tfIdf * importanceBoost * confidenceBoost * typeBoost, matchedTokens: matched });
        }
    }
    return out;
}

function scoreKnowledgeChunk({ queryTokens, cleanQuery, docs }) {
    const out = [];
    for (const item of docs) {
        const titleTokens = tokenizeLocal(item.title || "");
        const contentTokens = tokenizeLocal(item.content || "");
        let score = 0;
        const matched = [];
        for (const q of queryTokens) {
            if (titleTokens.includes(q)) { score += 5; matched.push(q); }
            else if (contentTokens.includes(q)) { score += 1.5; matched.push(q); }
        }
        if ((item.title || "").toLowerCase().includes(cleanQuery || "")) score += 10;
        if (score > 0) {
            out.push({ knowledge: item, score: score * (item.confidence || 1.0), matchedTokens: Array.from(new Set(matched)) });
        }
    }
    return out;
}

function scoreSessionChunk({ queryWords, docs }) {
    const qset = new Set(queryWords || []);
    const out = [];
    for (const msg of docs) {
        const words = new Set(String(msg.content || "").toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
        let score = 0;
        for (const w of qset) if (words.has(w)) score++;
        if (score > 0) out.push({ ...msg, score });
    }
    return out;
}

try {
    parentPort?.on("message", (job) => {
        (async () => {
            try {
                let scored = [];
                if (job.kind === "memory") scored = scoreMemoryChunk(job);
                else if (job.kind === "knowledge") scored = scoreKnowledgeChunk(job);
                else if (job.kind === "session") scored = scoreSessionChunk(job);
                else throw new Error(`unknown scoring kind: ${job.kind}`);
                parentPort.postMessage({ ok: true, jobId: job.jobId, scored });
            } catch (err) {
                parentPort.postMessage({ ok: false, jobId: job?.jobId, error: err?.message || String(err) });
            }
        })();
    });
} catch (err) {
    // Imported on main thread by accident — no parentPort, do nothing.
}
