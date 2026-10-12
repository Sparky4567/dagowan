import { describe, expect, test } from "bun:test";
import { availableParallelism, chunkArray, getOptimalWorkerCount, mapWithConcurrency } from "./concurrency.js";
import { searchMemoriesScored, searchKnowledgeScored, scoreSessionMessagesScored } from "./parallel_retrieval.js";
import { MemoryRetriever } from "../memory.js";
import { KnowledgeRetriever } from "../knowledge.js";
import { retrieveChatContextParallel } from "../chat_context.js";

describe("concurrency utils", () => {
    test("availableParallelism >= 1", () => {
        expect(availableParallelism()).toBeGreaterThanOrEqual(1);
    });
    test("chunkArray splits evenly", () => {
        expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([[1, 2, 3], [4, 5]]);
        expect(chunkArray([], 4)).toEqual([]);
    });
    test("mapWithConcurrency preserves order with limit", async () => {
        const out = await mapWithConcurrency([1, 2, 3, 4], async (x) => {
            await new Promise((r) => setTimeout(r, 5));
            return x * 2;
        }, { concurrency: 2 });
        expect(out).toEqual([2, 4, 6, 8]);
    });
    test("getOptimalWorkerCount bounds", () => {
        expect(getOptimalWorkerCount(0)).toBe(1);
        expect(getOptimalWorkerCount(1)).toBe(1);
        expect(getOptimalWorkerCount(100, { maxWorkers: 2 })).toBe(2);
    });
});

describe("parallel retrieval matches sync math", () => {
    test("memory scoring via workers equals sync (forced)", async () => {
        const docs = Array.from({ length: 12 }, (_, i) => ({
            id: `m${i}`, content: `user prefers tea number ${i} and coffee`, tags: ["preference"],
            type: "preference", confidence: 0.9, importance: 0.8,
        }));
        const queryTokens = ["prefers", "tea"];
        const viaWorkers = await searchMemoriesScored(docs, queryTokens, { forceWorkers: true, maxWorkers: 3 });
        const sync = await searchMemoriesScored(docs, queryTokens, { useWorkers: false });
        expect(viaWorkers.length).toBe(sync.length);
        expect(viaWorkers.map((r) => r.memory.id).sort()).toEqual(sync.map((r) => r.memory.id).sort());
        for (const r of viaWorkers) {
            const twin = sync.find((s) => s.memory.id === r.memory.id);
            expect(Math.abs(twin.score - r.score)).toBeLessThan(1e-9);
        }
    });

    test("knowledge scoring via workers equals sync (forced)", async () => {
        const docs = Array.from({ length: 10 }, (_, i) => ({
            id: `k${i}`, title: `Tea brewing ${i}`, content: `how to brew tea properly ${i}`, confidence: 1.0,
        }));
        const viaWorkers = await searchKnowledgeScored(docs, ["tea", "brew"], "tea", { forceWorkers: true, maxWorkers: 2 });
        const sync = await searchKnowledgeScored(docs, ["tea", "brew"], "tea", { useWorkers: false });
        expect(viaWorkers.length).toBe(sync.length);
    });

    test("session scoring via workers equals sync (forced)", async () => {
        const msgs = Array.from({ length: 20 }, (_, i) => ({
            session_title: "s", role: "user", content: `hello world tea ${i}`, updated_at: "",
        }));
        const viaWorkers = await scoreSessionMessagesScored(msgs, ["tea"], { forceWorkers: true, maxWorkers: 2 });
        const sync = await scoreSessionMessagesScored(msgs, ["tea"], { useWorkers: false });
        expect(viaWorkers.length).toBe(sync.length);
    });

    test("MemoryRetriever.searchParallel falls back cleanly on small DB", async () => {
        const r = new MemoryRetriever(null);
        const out = await r.searchParallel("hello", 3);
        expect(Array.isArray(out)).toBe(true);
    });

    test("KnowledgeRetriever.searchParallel returns array", async () => {
        const r = new KnowledgeRetriever(null);
        expect(Array.isArray(await r.searchParallel("hello", 2))).toBe(true);
    });

    test("retrieveChatContextParallel returns all three sources", async () => {
        const ctx = await retrieveChatContextParallel("hello", { memoryLimit: 2, knowledgeLimit: 2, sessionLimit: 2 });
        expect(Array.isArray(ctx.memories)).toBe(true);
        expect(Array.isArray(ctx.knowledge)).toBe(true);
        expect(Array.isArray(ctx.pastContext)).toBe(true);
    });
});
