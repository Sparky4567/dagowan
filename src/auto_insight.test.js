import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import {
    isSubstantiveTurn,
    recordTurnAndCheck,
    parseAutoInsightCommand,
    handleAutoInsightCommand,
    maybeAutoInsight,
    getAutoInsightConfig,
    formatAutoInsightStatus,
} from "./auto_insight.js";
import { addReflection, listReflections, searchReflections } from "./reflections.js";
import { isProbablyControlCommand } from "./security.js";

const STATE_FILE = "/tmp/opencode/auto-insight-test.json";
const REF_FILE = "/tmp/opencode/auto-insight-ref-test.json";

beforeEach(() => {
    try { fs.mkdirSync("/tmp/opencode", { recursive: true }); } catch {}
    try { fs.unlinkSync(STATE_FILE); } catch {}
    try { fs.unlinkSync(REF_FILE); } catch {}
});

afterEach(() => {
    try { fs.unlinkSync(STATE_FILE); } catch {}
    try { fs.unlinkSync(REF_FILE); } catch {}
});

describe("auto_insight gate", () => {
    test("trivial turns never count", () => {
        expect(isSubstantiveTurn("ok", 24)).toBe(false);
        expect(isSubstantiveTurn("thanks!", 24)).toBe(false);
        expect(isSubstantiveTurn("@insight status", 24)).toBe(false);
        expect(isSubstantiveTurn("short hi", 24)).toBe(false);
        expect(isSubstantiveTurn("I am building a solar-powered weather station with an ESP32 and I need help", 24)).toBe(true);
    });

    test("fires every N substantive turns", () => {
        const settings = { insight_auto_enabled: true, insight_auto_every_n: 3, insight_auto_cooldown_minutes: 0, insight_auto_min_chars: 10, insight_auto_max_per_day: 10 };
        const long = "I am building a solar-powered weather station and need architecture advice for the firmware";
        let r = recordTurnAndCheck({ characterId: "main", userText: long, settings, filePath: STATE_FILE, nowMs: 1000 });
        expect(r.shouldRun).toBe(false);
        r = recordTurnAndCheck({ characterId: "main", userText: long, settings, filePath: STATE_FILE, nowMs: 2000 });
        expect(r.shouldRun).toBe(false);
        r = recordTurnAndCheck({ characterId: "main", userText: long, settings, filePath: STATE_FILE, nowMs: 3000 });
        expect(r.shouldRun).toBe(true);
        // counter reset after fire
        r = recordTurnAndCheck({ characterId: "main", userText: long, settings, filePath: STATE_FILE, nowMs: 4000 });
        expect(r.shouldRun).toBe(false);
    });

    test("disabled setting never fires", () => {
        const settings = { insight_auto_enabled: false, insight_auto_every_n: 1, insight_auto_min_chars: 5 };
        const r = recordTurnAndCheck({ characterId: "main", userText: "a long enough substantive user message here", settings, filePath: STATE_FILE });
        expect(r.shouldRun).toBe(false);
        expect(r.reason).toBe("disabled");
    });

    test("cooldown blocks rapid re-fire", () => {
        const settings = { insight_auto_enabled: true, insight_auto_every_n: 1, insight_auto_cooldown_minutes: 60, insight_auto_min_chars: 5, insight_auto_max_per_day: 10 };
        const long = "a long enough substantive user message for cooldown testing purposes";
        const first = recordTurnAndCheck({ characterId: "c1", userText: long, settings, filePath: STATE_FILE, nowMs: 1_000_000 });
        expect(first.shouldRun).toBe(true);
        const second = recordTurnAndCheck({ characterId: "c1", userText: long, settings, filePath: STATE_FILE, nowMs: 1_000_001 });
        expect(second.shouldRun).toBe(false);
        expect(second.reason).toBe("cooldown");
    });

    test("daily cap blocks after max", () => {
        const settings = { insight_auto_enabled: true, insight_auto_every_n: 1, insight_auto_cooldown_minutes: 0, insight_auto_min_chars: 5, insight_auto_max_per_day: 1 };
        const long = "a long enough substantive user message for daily cap testing here";
        const now = Date.now();
        const first = recordTurnAndCheck({ characterId: "c2", userText: long, settings, filePath: STATE_FILE, nowMs: now });
        expect(first.shouldRun).toBe(true);
        const second = recordTurnAndCheck({ characterId: "c2", userText: long, settings, filePath: STATE_FILE, nowMs: now + 1000 });
        expect(second.shouldRun).toBe(false);
        expect(second.reason).toBe("daily-cap");
    });
});

describe("auto_insight commands", () => {
    test("parse covers family", () => {
        expect(parseAutoInsightCommand("@insight-auto")?.action).toBe("status");
        expect(parseAutoInsightCommand("@insight-auto on")?.action).toBe("on");
        expect(parseAutoInsightCommand("@insight-auto off")?.action).toBe("off");
        expect(parseAutoInsightCommand("@insight-auto every 5")?.action).toBe("every");
        expect(parseAutoInsightCommand("@insight-auto every 5")?.value).toBe(5);
        expect(parseAutoInsightCommand("@insight") ).toBeNull();
    });

    test("@insight-auto is lock-gated", () => {
        expect(isProbablyControlCommand("@insight-auto", [])).toBe(true);
        expect(isProbablyControlCommand("@insight-auto every 5", [])).toBe(true);
    });

    test("on/off/every mutate settings", async () => {
        const settings = {};
        let res = await handleAutoInsightCommand("@insight-auto off", { settings, persist: () => {} });
        expect(res.handled).toBe(true);
        expect(settings.insight_auto_enabled).toBe(false);
        res = await handleAutoInsightCommand("@insight-auto every 5", { settings, persist: () => {} });
        expect(settings.insight_auto_every_n).toBe(5);
        expect(formatAutoInsightStatus(settings, STATE_FILE)).toContain("every 5");
    });

    test("config defaults", () => {
        const cfg = getAutoInsightConfig({});
        expect(cfg.enabled).toBe(true);
        expect(cfg.everyN).toBe(8);
    });
});

describe("auto_insight generation", () => {
    test("maybeAutoInsight stores micro-entry with fake chat (no network)", async () => {
        const settings = { model: "test", insight_auto_enabled: true, insight_auto_every_n: 1, insight_auto_cooldown_minutes: 0, insight_auto_min_chars: 5, insight_auto_max_per_day: 10 };
        const fakeChat = async () => ({ content: "• Learned user likes tea\n• Carry tea preference forward" });
        const entry = await maybeAutoInsight({
            settings,
            characterId: "main",
            personaName: "Tester",
            userText: "I really like drinking strong black tea in the mornings",
            sessionMessages: [{ role: "user", content: "I really like drinking strong black tea in the mornings" }],
            unifiedChatFn: fakeChat,
            filePath: REF_FILE,
            statePath: STATE_FILE,
        });
        expect(entry).not.toBeNull();
        expect(entry.source).toBe("auto-insight");
        const listed = listReflections({ filePath: REF_FILE });
        expect(listed.length).toBe(1);
        // association recall finds it later
        const hits = searchReflections("black tea mornings", { filePath: REF_FILE });
        expect(hits.length).toBe(1);
        // fallback when LLM unreachable still stores
        const settings2 = { model: "test", insight_auto_enabled: true, insight_auto_every_n: 1, insight_auto_cooldown_minutes: 0, insight_auto_min_chars: 5, insight_auto_max_per_day: 10 };
        const entry2 = await maybeAutoInsight({
            settings: settings2,
            characterId: "other",
            userText: "I am building a garden irrigation system with moisture sensors",
            sessionMessages: [],
            unifiedChatFn: async () => { throw new Error("offline"); },
            filePath: REF_FILE,
            statePath: "/tmp/opencode/auto-insight-test2.json",
        });
        expect(entry2).not.toBeNull();
        try { fs.unlinkSync("/tmp/opencode/auto-insight-test2.json"); } catch {}
    });

    test("manual reflections and auto-insights share one bank", () => {
        addReflection({ content: "Manual daily note about docker workflow.", characterId: "main" }, { filePath: REF_FILE, characterId: "main" });
        addReflection({ content: "Auto micro note about docker workflow continuity.", characterId: "main", source: "auto-insight" }, { filePath: REF_FILE, characterId: "main" });
        const hits = searchReflections("docker workflow", { characterId: "main", filePath: REF_FILE });
        expect(hits.length).toBe(2);
    });
});
