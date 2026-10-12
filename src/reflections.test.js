import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import {
    addReflection,
    listReflections,
    searchReflections,
    parseInsightCommand,
    handleReflectionBridgeCommand,
    formatReflectionBlock,
    getReflectionChatAugmentation,
} from "./reflections.js";
import { isProbablyControlCommand } from "./security.js";

const TEST_FILE = "/tmp/opencode/reflections-test.json";

beforeEach(() => {
    try { fs.unlinkSync(TEST_FILE); } catch {}
    try { fs.mkdirSync("/tmp/opencode", { recursive: true }); } catch {}
});

afterEach(() => {
    try { fs.unlinkSync(TEST_FILE); } catch {}
    try { fs.unlinkSync("data/reflections.json"); } catch {}
});

describe("reflections bank", () => {
    test("add + list roundtrip, per-character scoping", () => {
        const a = addReflection({ content: "Parsly learned users like tea.", characterId: "parsly" }, { filePath: TEST_FILE, characterId: "parsly" });
        expect(a.id).toStartWith("ref_");
        addReflection({ content: "Whiskers prefers fish.", characterId: "whiskers" }, { filePath: TEST_FILE, characterId: "whiskers" });
        const parsly = listReflections({ characterId: "parsly", filePath: TEST_FILE });
        expect(parsly.length).toBe(1);
        expect(parsly[0].content).toContain("tea");
        const all = listReflections({ filePath: TEST_FILE });
        expect(all.length).toBe(2);
    });

    test("search returns only genuine matches", () => {
        addReflection("Today I learned the user deploys via docker compose.", { filePath: TEST_FILE });
        addReflection("Unrelated note about gardening roses.", { filePath: TEST_FILE });
        const hits = searchReflections("docker compose deploy", { filePath: TEST_FILE });
        expect(hits.length).toBe(1);
        expect(hits[0].reflection.content).toContain("docker");
        const none = searchReflections("quantum entanglement zebra", { filePath: TEST_FILE });
        expect(none.length).toBe(0);
    });

    test("parseInsightCommand covers family", () => {
        expect(parseInsightCommand("@insight")?.action).toBe("generate");
        expect(parseInsightCommand("@insight focus on work")?.action).toBe("generate");
        expect(parseInsightCommand("@insights")?.action).toBe("list");
        expect(parseInsightCommand("@insight-list")?.action).toBe("list");
        expect(parseInsightCommand("@insight-search docker")?.action).toBe("search");
        expect(parseInsightCommand("@insight-show abc")?.target).toBe("abc");
        expect(parseInsightCommand("@insight-delete abc")?.action).toBe("delete");
        expect(parseInsightCommand("hello world")).toBeNull();
    });

    test("@insight words are lock-gated control commands", () => {
        for (const cmd of ["@insight", "@insights", "@insight-search x", "@insight-show x", "@insight-list", "@insight-delete x"]) {
            expect(isProbablyControlCommand(cmd, [])).toBe(true);
        }
    });

    test("bridge list/search/show/delete flow", async () => {
        addReflection("Reflection about docker workflow.", { filePath: TEST_FILE });
        const list = await handleReflectionBridgeCommand("@insights", { characterId: "main", settings: {}, filePath: TEST_FILE });
        expect(list.handled).toBe(true);
        expect(list.reply).toContain("Reflections");
        const search = await handleReflectionBridgeCommand("@insight-search docker", { characterId: "main", settings: {}, filePath: TEST_FILE });
        expect(search.reply).toContain("docker");
        const miss = await handleReflectionBridgeCommand("@insight-search zzzqqq", { characterId: "main", settings: {}, filePath: TEST_FILE });
        expect(miss.reply).toContain("No reflections match");
    });

    test("bridge generate uses injected chat fn (no network)", async () => {
        const fakeChat = async () => ({ content: "• Learned X\n• Remember Y\n• Improve Z" });
        const res = await handleReflectionBridgeCommand("@insight", {
            characterId: "main",
            personaName: "Tester",
            settings: { model: "test" },
            unifiedChatFn: fakeChat,
            filePath: TEST_FILE,
        });
        expect(res.handled).toBe(true);
        expect(res.reply).toContain("Daily reflection saved");
        const listed = listReflections({ filePath: TEST_FILE });
        expect(listed.length).toBe(1);
    });

    test("augmentation block empty when no match", () => {
        addReflection("Gardening roses note.", { filePath: TEST_FILE });
        const aug = getReflectionChatAugmentation("docker compose", { filePath: TEST_FILE });
        expect(aug.block).toBe("");
        const hit = getReflectionChatAugmentation("gardening roses", { filePath: TEST_FILE });
        expect(hit.block).toContain("Self-Reflections");
        expect(formatReflectionBlock([])).toBe("");
    });
});
