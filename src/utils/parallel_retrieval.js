/**
 * Parallel retrieval scoring with worker_threads.
 *
 * Rule: DB + file reads stay on the main thread (bun:sqlite handles and
 * the memoize cache are not transferable). Only the CPU-bound scoring
 * loop is fanned out to workers, and only when the corpus is large
 * enough to amortize spawn + structured-clone overhead.
 */
import { Worker } from "node:worker_threads";
import { chunkArray, getOptimalWorkerCount } from "./concurrency.js";

const WORKER_URL = new URL("./retrieval_worker.js", import.meta.url);

// Below these sizes sync scoring is faster than spawning workers.
export const MEMORY_WORKER_THRESHOLD = 100;
export const KNOWLEDGE_WORKER_THRESHOLD = 100;
export const SESSION_WORKER_THRESHOLD = 300;

let workerSeq = 0;

function runChunk(job, { timeoutMs = 15000 } = {}) {
    return new Promise((resolve, reject) => {
        let worker;
        try {
            worker = new Worker(WORKER_URL);
        } catch (err) {
            reject(err);
            return;
        }
        const timer = setTimeout(() => {
            try { worker.terminate(); } catch {}
            reject(new Error("retrieval worker timed out"));
        }, timeoutMs);
        timer.unref?.();
        worker.once("message", (msg) => {
            clearTimeout(timer);
            try { worker.terminate(); } catch {}
            if (msg?.ok) resolve(msg.scored);
            else reject(new Error(msg?.error || "retrieval worker failed"));
        });
        worker.once("error", (err) => {
            clearTimeout(timer);
            try { worker.terminate(); } catch {}
            reject(err);
        });
        worker.postMessage({ ...job, jobId: `${Date.now()}_${workerSeq++}` });
    });
}

async function scoreInWorkers(kind, chunks, baseJob, options = {}) {
    const jobs = chunks.map((docs) => ({ ...baseJob, kind, docs }));
    const settled = await Promise.all(
        jobs.map((j) => runChunk(j, options).catch((err) => ({ __workerError: err })))
    );
    const failed = settled.find((r) => r?.__workerError);
    if (failed) throw failed.__workerError;
    return settled.flat();
}

// ---- pure sync fallbacks (same math as the worker, single-threaded) ----

function tokenizeLocal(text, stopWords) {
    if (!text || typeof text !== "string") return [];
    return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/)
        .filter((w) => w.length > 1 && !stopWords.has(w));
}
const MEM_STOP = new Set(["the","a","an","and","or","but","in","on","at","to","for","of","with","by","from","up","about","into","over","after","is","am","are","was","were","be","been","being","have","has","had","do","does","did","can","could","shall","should","will","would","it","its","what","which","who","whom","this","that","these","those","tell","show","me","you","i","we","they"]);

function scoreMemoriesSync(activeMemories, queryTokens) {
    const docFreq = new Map();
    const docTokensMap = new Map();
    for (const mem of activeMemories) {
        const toks = Array.from(new Set(tokenizeLocal(`${mem.content} ${(mem.tags || []).join(" ")}`, MEM_STOP)));
        docTokensMap.set(mem.id, toks);
        for (const t of toks) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
    }
    const N = activeMemories.length;
    const out = [];
    for (const mem of activeMemories) {
        const docTokens = docTokensMap.get(mem.id) || [];
        let s = 0; const matched = [];
        for (const q of queryTokens) {
            if (docTokens.includes(q)) {
                matched.push(q);
                s += Math.log((N + 1) / (docFreq.get(q) || 1)) + 1;
            }
        }
        if (matched.length > 0) {
            const ib = 1 + (mem.importance || 0.5) * 0.5;
            const cb = mem.confidence || 1.0;
            const tb = mem.type === "correction" ? 1.5 : mem.type === "project" ? 1.2 : mem.type === "preference" ? 1.1 : 1.0;
            out.push({ memory: mem, score: s * ib * cb * tb, matchedTokens: matched });
        }
    }
    return { out, docFreq, N };
}

/** Score memory docs; uses workers only above threshold (or when forced). */
export async function searchMemoriesScored(activeMemories, queryTokens, { useWorkers = true, maxWorkers = 0, timeoutMs = 15000, forceWorkers = false } = {}) {
    if (activeMemories.length === 0 || queryTokens.length === 0) return [];
    const threshold = MEMORY_WORKER_THRESHOLD;
    if (!useWorkers || (!forceWorkers && activeMemories.length < threshold)) {
        return scoreMemoriesSync(activeMemories, queryTokens).out;
    }
    // Main thread builds docFreq once (cheap O(N)), workers score chunks.
    const freq = new Map();
    for (const mem of activeMemories) {
        const toks = new Set(tokenizeLocal(`${mem.content} ${(mem.tags || []).join(" ")}`, MEM_STOP));
        for (const t of toks) freq.set(t, (freq.get(t) ?? 0) + 1);
    }
    const workers = getOptimalWorkerCount(activeMemories.length, { maxWorkers });
    const chunks = chunkArray(activeMemories, workers);
    try {
        return await scoreInWorkers("memory", chunks, {
            queryTokens,
            docFreq: Object.fromEntries(freq),
            totalDocs: activeMemories.length,
        }, { timeoutMs });
    } catch {
        return scoreMemoriesSync(activeMemories, queryTokens).out;
    }
}

/** Score knowledge docs; workers only above threshold (or when forced). */
export async function searchKnowledgeScored(allKnowledge, queryTokens, cleanQuery, { useWorkers = true, maxWorkers = 0, timeoutMs = 15000, forceWorkers = false } = {}) {
    if (allKnowledge.length === 0 || queryTokens.length === 0) return [];
    if (!useWorkers || (!forceWorkers && allKnowledge.length < KNOWLEDGE_WORKER_THRESHOLD)) {
        return scoreKnowledgeSync(allKnowledge, queryTokens, cleanQuery);
    }
    const workers = getOptimalWorkerCount(allKnowledge.length, { maxWorkers });
    const chunks = chunkArray(allKnowledge, workers);
    try {
        return await scoreInWorkers("knowledge", chunks, { queryTokens, cleanQuery }, { timeoutMs });
    } catch {
        return scoreKnowledgeSync(allKnowledge, queryTokens, cleanQuery);
    }
}

function scoreKnowledgeSync(allKnowledge, queryTokens, cleanQuery) {
    const out = [];
    for (const item of allKnowledge) {
        const tt = tokenizeLocal(item.title, MEM_STOP);
        const ct = tokenizeLocal(item.content, MEM_STOP);
        let score = 0; const matched = [];
        for (const q of queryTokens) {
            if (tt.includes(q)) { score += 5; matched.push(q); }
            else if (ct.includes(q)) { score += 1.5; matched.push(q); }
        }
        if ((item.title || "").toLowerCase().includes(cleanQuery)) score += 10;
        if (score > 0) out.push({ knowledge: item, score: score * (item.confidence || 1.0), matchedTokens: [...new Set(matched)] });
    }
    return out;
}

/** Score session messages; workers only above threshold (or when forced). */
export async function scoreSessionMessagesScored(messages, queryWords, { useWorkers = true, maxWorkers = 0, timeoutMs = 15000, forceWorkers = false } = {}) {
    if (messages.length === 0 || queryWords.length === 0) return [];
    if (!useWorkers || (!forceWorkers && messages.length < SESSION_WORKER_THRESHOLD)) {
        return scoreSessionSync(messages, queryWords);
    }
    const workers = getOptimalWorkerCount(messages.length, { maxWorkers });
    const chunks = chunkArray(messages, workers);
    try {
        return await scoreInWorkers("session", chunks, { queryWords }, { timeoutMs });
    } catch {
        return scoreSessionSync(messages, queryWords);
    }
}

function scoreSessionSync(messages, queryWords) {
    const qset = new Set(queryWords);
    const out = [];
    for (const m of messages) {
        const words = new Set(String(m.content || "").toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
        let s = 0;
        for (const w of qset) if (words.has(w)) s++;
        if (s > 0) out.push({ ...m, score: s });
    }
    return out;
}
