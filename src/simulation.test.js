import { describe, test, expect, beforeEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
    parseSimulationCommand,
    sanitizeSimulationName,
    startSimulation,
    getActiveSimulation,
    appendSimulationExchange,
    addSimulationMemory,
    extractSimulationHeuristic,
    searchSimulation,
    searchSimulationArchives,
    endSimulation,
    listSimulations,
    scopeKeyFor,
    buildSimulationSystemPrompt,
    formatSimulationReview,
} from "./simulation.js";

const TEST_DIR = "/tmp/opencode/sim_test";
const TEST_STATE = "/tmp/opencode/sim_test_state.json";

function clean() {
    try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
    try { fs.unlinkSync(TEST_STATE); } catch {}
    fs.mkdirSync(TEST_DIR, { recursive: true });
}

describe("simulation command parsing", () => {
    test("start with name + scenario", () => {
        expect(parseSimulationCommand("@simulation dreamquest | a haunted library")).toEqual({ action: "start", name: "dreamquest", scenario: "a haunted library" });
        expect(parseSimulationCommand("@simulation dreamquest a haunted library")).toEqual({ action: "start", name: "dreamquest", scenario: "a haunted library" });
        expect(parseSimulationCommand("@simulation dreamquest")).toEqual({ action: "start", name: "dreamquest", scenario: "" });
    });
    test("end aliases", () => {
        for (const c of ["@simulation-end", "@simulation-stop", "@simulation-passed", "@simulation-pass", "@simulation end", "@simulation stop", "@simulation passed", "/simulation-end"]) {
            expect(parseSimulationCommand(c)).toEqual({ action: "end" });
        }
    });
    test("status/list/search/show/review", () => {
        expect(parseSimulationCommand("@simulation")).toEqual({ action: "status" });
        expect(parseSimulationCommand("@simulations")).toEqual({ action: "list" });
        expect(parseSimulationCommand("@simulation-search dragons")).toEqual({ action: "search", query: "dragons" });
        expect(parseSimulationCommand("@simulation show dreamquest")).toEqual({ action: "show", name: "dreamquest" });
        expect(parseSimulationCommand("@simulation-review dreamquest")).toEqual({ action: "review", name: "dreamquest" });
        expect(parseSimulationCommand("@simulation review dreamquest")).toEqual({ action: "review", name: "dreamquest" });
        expect(parseSimulationCommand("@sim-review dreamquest")).toEqual({ action: "review", name: "dreamquest" });
    });
    test("non-simulation returns null", () => {
        expect(parseSimulationCommand("@remember foo")).toBeNull();
        expect(parseSimulationCommand("hello")).toBeNull();
    });
    test("sanitize", () => {
        expect(sanitizeSimulationName("Dream Quest 42!")).toBe("dream-quest-42");
    });
});

describe("simulation lifecycle", () => {
    beforeEach(clean);
    test("start -> exchange -> memory -> recall -> end", () => {
        const scope = scopeKeyFor("cli", "char1", "cli");
        const sim = startSimulation({ name: "dreamquest", scenario: "haunted library, whisper only", characterId: "char1", personaName: "Tester", scopeKey: scope, dir: TEST_DIR, stateFile: TEST_STATE });
        expect(sim.slug).toBe("dreamquest");
        expect(sim.status).toBe("active");

        const active = getActiveSimulation(scope, { dir: TEST_DIR, stateFile: TEST_STATE });
        expect(active?.name).toBe("dreamquest");
        expect(buildSimulationSystemPrompt("Tester", active)).toContain("dreamquest");

        appendSimulationExchange("dreamquest", "I prefer candlelight for reading", "Noted, the library dims.", { dir: TEST_DIR });
        extractSimulationHeuristic("dreamquest", "I prefer candlelight for reading", { dir: TEST_DIR });
        addSimulationMemory("dreamquest", "The librarian ghost is named Morrow.", { dir: TEST_DIR });

        const local = searchSimulation("candlelight reading", "dreamquest", { dir: TEST_DIR });
        expect(local.length).toBeGreaterThan(0);

        // Cross-archive recall matches, unrelated query does not.
        const hit = searchSimulationArchives("librarian Morrow ghost", { characterId: "char1", dir: TEST_DIR });
        expect(hit.length).toBeGreaterThan(0);
        expect(hit[0].simulation).toBe("dreamquest");
        const miss = searchSimulationArchives("quantum zebra helicopter", { characterId: "char1", dir: TEST_DIR });
        expect(miss.length).toBe(0);

        // Other character's sims are excluded from auto recall.
        const other = searchSimulationArchives("Morrow", { characterId: "other-char", dir: TEST_DIR });
        expect(other.length).toBe(0);

        const ended = endSimulation(scope, { dir: TEST_DIR, stateFile: TEST_STATE });
        expect(ended?.status).toBe("archived");
        expect(getActiveSimulation(scope, { dir: TEST_DIR, stateFile: TEST_STATE })).toBeNull();

        const all = listSimulations({ dir: TEST_DIR });
        expect(all.length).toBe(1);
        expect(all[0].memories).toBeGreaterThanOrEqual(2);
    });
    test("review covers all conversational data", () => {
        const scope = scopeKeyFor("cli", "char1", "cli");
        startSimulation({ name: "dreamquest", scenario: "", characterId: "char1", personaName: "Tester", scopeKey: scope, dir: TEST_DIR, stateFile: TEST_STATE });
        appendSimulationExchange("dreamquest", "Hello library", "Hello traveler", { dir: TEST_DIR });
        appendSimulationExchange("dreamquest", "Who is Morrow?", "The ghost librarian", { dir: TEST_DIR });
        const review = formatSimulationReview("dreamquest", { dir: TEST_DIR });
        expect(review).toContain('Review: "dreamquest"');
        expect(review).toContain("4 message(s)");
        expect(review).toContain("Hello library");
        expect(review).toContain("ghost librarian");
        expect(review).toContain("Topics:");
        expect(formatSimulationReview("missing-sim", { dir: TEST_DIR })).toBe("🎭 Simulation not found.");
    });
});
