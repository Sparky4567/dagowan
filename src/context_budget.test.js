import { describe, expect, test } from "bun:test";
import {
    estimateTokens,
    estimateMessagesTokens,
    summarizeMessages,
    dedupeMessages,
    messagePriority,
    sortMessagesByPriority,
    selectMessagesWithinBudget,
    trimMessagesToBudget,
} from "./context_budget.js";

describe("context_budget", () => {
    test("estimateTokens approximates 4 chars/token", () => {
        expect(estimateTokens("")).toBe(0);
        expect(estimateTokens("abcd")).toBe(1);
        expect(estimateTokens("abcde")).toBe(2);
    });

    test("estimateMessagesTokens sums messages", () => {
        const msgs = [{ content: "abcd" }, { content: "efgh" }];
        expect(estimateMessagesTokens(msgs)).toBe(2 + 8); // 2 tokens + 4 overhead each
    });

    test("summarizeMessages dedupes and caps", () => {
        const msgs = [
            { role: "user", content: "Hello world. Extra." },
            { role: "user", content: "Hello world. Extra." },
            { role: "assistant", content: "Hi there." },
        ];
        const s = summarizeMessages(msgs, { maxItems: 2 });
        expect(s).toContain("user: Hello world.");
        expect(s.split("\n").length).toBe(2);
    });

    test("dedupeMessages keeps last occurrence", () => {
        const msgs = [
            { role: "user", content: "hi" },
            { role: "assistant", content: "hello" },
            { role: "user", content: "hi" },
        ];
        const out = dedupeMessages(msgs);
        expect(out).toHaveLength(2);
        expect(out[0].role).toBe("assistant");
        expect(out[1].content).toBe("hi");
    });

    test("sortMessagesByPriority is stable for ties", () => {
        const msgs = [
            { role: "user", content: "a" },
            { role: "user", content: "b" },
        ];
        const out = sortMessagesByPriority(msgs);
        // Later messages have higher recency priority.
        expect(out.map((m) => m.content)).toEqual(["b", "a"]);
    });

    test("sortMessagesByPriority puts system first", () => {
        const msgs = [
            { role: "user", content: "q" },
            { role: "system", content: "sys" },
        ];
        const out = sortMessagesByPriority(msgs);
        expect(out[0].role).toBe("system");
    });

    test("selectMessagesWithinBudget preserves chronological order", () => {
        const msgs = [
            { role: "system", content: "S" },
            { role: "user", content: "old question" },
            { role: "assistant", content: "old answer" },
            { role: "user", content: "new question" },
        ];
        const out = selectMessagesWithinBudget(msgs, 1000);
        expect(out[out.length - 1].content).toBe("new question");
        expect(out[0].role).toBe("system");
    });

    test("selectMessagesWithinBudget trims to budget", () => {
        const big = "x".repeat(4000);
        const msgs = [
            { role: "user", content: big },
            { role: "user", content: "short" },
        ];
        const out = selectMessagesWithinBudget(msgs, 10);
        // budget tiny: only the short message should survive (system none)
        const contents = out.map((m) => m.content);
        expect(contents).toContain("short");
    });

    test("trimMessagesToBudget keeps recent and preserves system", () => {
        const msgs = [
            { role: "system", content: "sys" },
            { role: "user", content: "first" },
            { role: "assistant", content: "second" },
            { role: "user", content: "third" },
        ];
        const out = trimMessagesToBudget(msgs, 1000);
        expect(out[0].role).toBe("system");
        expect(out.map((m) => m.content)).toContain("third");
    });

    test("trimMessagesToBudget collapses exact duplicates", () => {
        const msgs = [
            { role: "user", content: "hi" },
            { role: "user", content: "hi" },
        ];
        const out = trimMessagesToBudget(msgs, 1000);
        expect(out).toHaveLength(1);
    });

    test("messagePriority returns finite number", () => {
        expect(Number.isFinite(messagePriority({ role: "user", content: "hi" }, 0, 1))).toBe(true);
    });
});
