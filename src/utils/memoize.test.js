import { describe, expect, test } from "bun:test";
import { memoize, memoizeAsync, defaultKeyResolver } from "./memoize.js";
import { tokenize as memoryTokenize } from "../memory.js";
import { tokenize as knowledgeTokenize } from "../knowledge.js";
import { detectProvider, normalizeModelName } from "../providers.js";
import { isTrivialTurn, isNeedleFastPathCandidate } from "../needle.js";
import { normalizeStatus, parseMoveTaskCommand } from "../tasks.js";

describe("memoize (sync)", () => {
    test("caches by JSON args like the classic snippet", () => {
        let calls = 0;
        const fn = memoize((num) => { calls++; return num * 2; });
        expect(fn(21)).toBe(42);
        expect(fn(21)).toBe(42);
        expect(calls).toBe(1);
        expect(fn(7)).toBe(14);
        expect(calls).toBe(2);
    });

    test("supports objects, LRU eviction, clear and stats", () => {
        let calls = 0;
        const fn = memoize((o) => { calls++; return o.x; }, { maxSize: 2 });
        expect(fn({ x: 1 })).toBe(1);
        expect(fn({ x: 1 })).toBe(1);
        expect(fn.stats.hits).toBe(1);
        fn({ x: 2 }); fn({ x: 3 }); // evicts {x:1}
        expect(fn.cache.size).toBe(2);
        fn({ x: 1 });
        expect(calls).toBe(4); // had to recompute after eviction
        expect(fn.delete({ x: 1 })).toBe(true);
        fn.clear();
        expect(fn.cache.size).toBe(0);
    });

    test("TTL expires entries", async () => {
        let calls = 0;
        const fn = memoize(() => ++calls, { ttlMs: 20 });
        expect(fn("k")).toBe(1);
        expect(fn("k")).toBe(1);
        await new Promise((r) => setTimeout(r, 40));
        expect(fn("k")).toBe(2);
    });

    test("defaultKeyResolver fast path + circular fallback", () => {
        expect(defaultKeyResolver("hi")).toBe("s:hi");
        const c = {};
        c.self = c;
        expect(typeof defaultKeyResolver(c)).toBe("string");
    });
});

describe("memoizeAsync", () => {
    test("dedupes in-flight promises, drops rejections", async () => {
        let calls = 0;
        const fn = memoizeAsync(async (x) => { calls++; await new Promise((r) => setTimeout(r, 10)); return x * 2; });
        const [a, b] = await Promise.all([fn(5), fn(5)]);
        expect(a).toBe(10);
        expect(b).toBe(10);
        expect(calls).toBe(1);
        expect(await fn(5)).toBe(10);
        expect(calls).toBe(1);

        let fails = 0;
        const flaky = memoizeAsync(async () => { fails++; throw new Error("boom"); });
        await expect(flaky()).rejects.toThrow("boom");
        await expect(flaky()).rejects.toThrow("boom");
        expect(fails).toBe(2); // not cached
    });
});

describe("project integrations stay correct", () => {
    test("memoized tokenizers strip stop words, return cached ref", () => {
        expect(memoryTokenize("The cat sat on the mat")).toEqual(["cat", "sat", "mat"]);
        expect(memoryTokenize("The cat sat on the mat")).toBe(memoryTokenize("The cat sat on the mat"));
        expect(knowledgeTokenize("Hello, hello world!")).toEqual(["hello", "hello", "world"]);
    });

    test("memoized pure helpers keep behavior + cache hits", () => {
        expect(detectProvider("openai:gpt-4o")).toBe("openai");
        expect(detectProvider("openai:gpt-4o")).toBe("openai");
        expect(detectProvider.stats.hits).toBeGreaterThanOrEqual(1);
        expect(normalizeModelName("openai:gpt-4o")).toBe("gpt-4o");
        expect(isTrivialTurn("ok")).toBe(true);
        expect(isNeedleFastPathCandidate("remember that I prefer oat milk")).toBe(true);
        expect(normalizeStatus("finished")).toBe("f");
        expect(parseMoveTaskCommand("@move-task 3 finished")).toEqual({ taskId: 3, status: "f" });
    });
});
