import { test, expect, describe, beforeEach } from "bun:test";
import { BotDatabase } from "./db/database.js";
import { MemoryStore, MemoryRetriever } from "./memory.js";
import { KnowledgeStore, KnowledgeRetriever } from "./knowledge.js";
import { LearningPipeline } from "./learning.js";
import { handleAtCommand as handleSlashCommand } from "./commands.js";

describe("Incremental Learning & Memory Storage Suite", () => {
    let db;
    let memoryStore;
    let knowledgeStore;
    let learningPipeline;

    beforeEach(() => {
        // Use in-memory SQLite for isolated unit testing
        db = new BotDatabase(":memory:");
        memoryStore = new MemoryStore(db);
        knowledgeStore = new KnowledgeStore(db);
        learningPipeline = new LearningPipeline(db, memoryStore, knowledgeStore);
    });

    test("MemoryStore: adds, lists, and touches active memories", () => {
        const mem1 = memoryStore.addMemory({
            type: "fact",
            content: "User works as a software architect.",
            confidence: 0.95,
            importance: 0.8,
            tags: ["job", "tech"],
        });

        expect(mem1.id).toBeDefined();
        expect(mem1.content).toBe("User works as a software architect.");
        expect(mem1.status).toBe("active");

        const active = memoryStore.getActiveMemories();
        expect(active.length).toBe(1);
        expect(active[0].content).toBe("User works as a software architect.");

        memoryStore.touchMemory(mem1.id);
        const touched = memoryStore.getMemory(mem1.id);
        expect(touched.usageCount).toBe(1);
        expect(touched.lastUsedAt).toBeDefined();
    });

    test("MemoryStore: handles deduplication of identical content", () => {
        const m1 = memoryStore.addMemory("I love coding in Bun.");
        const m2 = memoryStore.addMemory("I love coding in Bun.");

        expect(m1.id).toBe(m2.id);
        const active = memoryStore.getActiveMemories();
        expect(active.length).toBe(1);
    });

    test("MemoryStore: supersedes conflicting memories when corrections or topic updates are made", () => {
        const initial = memoryStore.addMemory({
            type: "preference",
            content: "User prefers PostgreSQL database.",
            tags: ["database"],
        });

        expect(initial.status).toBe("active");

        // Now add a conflicting memory of same type
        const updated = memoryStore.addMemory({
            type: "preference",
            content: "User prefers SQLite database for lightweight apps.",
            tags: ["database"],
        });

        const oldMem = memoryStore.getMemory(initial.id);
        expect(oldMem.status).toBe("superseded");
        expect(oldMem.supersededBy).toBe(updated.id);

        const newMem = memoryStore.getMemory(updated.id);
        expect(newMem.status).toBe("active");
    });

    test("MemoryStore: forgets memory on demand", () => {
        const mem = memoryStore.addMemory("Temporary note that should be deleted.");
        expect(memoryStore.getActiveMemories().length).toBe(1);

        memoryStore.forgetMemory(mem.id);
        expect(memoryStore.getActiveMemories().length).toBe(0);

        const forgotten = memoryStore.getMemory(mem.id);
        expect(forgotten.status).toBe("forgotten");
    });

    test("MemoryRetriever: performs TF-IDF relevance scoring", () => {
        memoryStore.addMemory({
            type: "fact",
            content: "The user has a cat named Whiskers.",
            importance: 0.9,
        });
        memoryStore.addMemory({
            type: "project",
            content: "The user is developing a voice assistant with Whisper and TTS.",
            importance: 0.9,
        });

        const retriever = new MemoryRetriever(memoryStore);

        const catResults = retriever.search("What is the name of my pet cat?");
        expect(catResults.length).toBeGreaterThan(0);
        expect(catResults[0].memory.content).toContain("Whiskers");

        const voiceResults = retriever.search("Tell me about my speech and voice project");
        expect(voiceResults.length).toBeGreaterThan(0);
        expect(voiceResults[0].memory.content).toContain("developing a voice assistant");
    });

    test("KnowledgeStore: adds and auto-versions concepts when updating with same title", () => {
        const v1 = knowledgeStore.addKnowledge({
            title: "Bun Runtime",
            content: "Bun is an all-in-one JavaScript runtime with a fast native package manager.",
            category: "technology",
            confidence: 0.9,
            changeReason: "Initial entry",
        });

        expect(v1.version).toBe(1);
        expect(v1.status).toBe("active");

        // Add updated version for same title
        const v2 = knowledgeStore.addKnowledge({
            title: "Bun Runtime",
            content: "Bun is an all-in-one JavaScript runtime featuring built-in SQLite, test runner, and bundler.",
            category: "technology",
            confidence: 0.95,
            changeReason: "Added built-in SQLite details",
        });

        expect(v2.version).toBe(2);
        expect(v2.status).toBe("active");
        expect(v2.previousVersionId).toBe(v1.id);

        const oldEntry = knowledgeStore.getKnowledge(v1.id);
        expect(oldEntry.status).toBe("deprecated");

        const history = knowledgeStore.getVersionHistory(v2.id);
        expect(history.length).toBe(2);
        expect(history[0].version).toBe(2);
        expect(history[1].version).toBe(1);
    });

    test("KnowledgeRetriever: searches concepts with title weighting", () => {
        knowledgeStore.addKnowledge({
            title: "SQLite WAL Mode",
            content: "Write-Ahead Logging provides concurrency for read and write operations.",
            category: "programming",
        });
        knowledgeStore.addKnowledge({
            title: "Audio Synthesis",
            content: "Text to speech models convert text into waveform audio buffers.",
            category: "technology",
        });

        const retriever = new KnowledgeRetriever(knowledgeStore);
        const results = retriever.search("SQLite concurrency");
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].knowledge.title).toBe("SQLite WAL Mode");
    });

    test("LearningPipeline: fast deterministic heuristic extraction", () => {
        // 1. Correction
        const corrRes = learningPipeline.extractHeuristic("Actually, I changed it. I switched to Bun SQLite now");
        expect(corrRes.correctionsHandled).toBe(1);
        expect(corrRes.memoriesCreated).toBe(1);

        // 2. Project
        const projRes = learningPipeline.extractHeuristic("I am building an autonomous AI agent for Linux systems");
        expect(projRes.memoriesCreated).toBe(1);

        // 3. Preference
        const prefRes = learningPipeline.extractHeuristic("My favorite framework is Svelte");
        expect(prefRes.memoriesCreated).toBe(1);

        const active = memoryStore.getActiveMemories();
        expect(active.length).toBe(3);
    });

    test("LearningPipeline: strategy statistics and learning stats", () => {
        const stats = db.getStats();
        expect(stats.activeMemories).toBeDefined();
        expect(stats.activeKnowledge).toBeDefined();
        expect(stats.totalLearningLogs).toBeDefined();
    });

    test("Slash Commands: /remember, /correct, /teach, /stats work smoothly", async () => {
        const context = {
            settings: {},
            messages: [],
            activeSessionId: "test_session",
        };

        // @remember
        const remRes = await handleSlashCommand({
            commandStr: "@remember My secret favorite fruit is Mango",
            context,
        });
        expect(remRes.handled).toBe(true);

        // @correct
        const corrRes = await handleSlashCommand({
            commandStr: "@correct Actually my favorite fruit is Peach",
            context,
        });
        expect(corrRes.handled).toBe(true);

        // @teach
        const teachRes = await handleSlashCommand({
            commandStr: "@teach Matrix Multiplication: Row by column dot products in linear algebra",
            context,
        });
        expect(teachRes.handled).toBe(true);

        // @stats
        const statsRes = await handleSlashCommand({
            commandStr: "@stats",
            context,
        });
        expect(statsRes.handled).toBe(true);
    });
});
