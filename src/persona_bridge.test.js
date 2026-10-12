import { describe, expect, test } from "bun:test";
import { PersonaPollingBridge } from "./persona_bridge.js";

function fakeStore() {
    return {
        active_character: "alpha",
        characters: [
            { id: "alpha", name: "Alpha", telegram_token: "tok-alpha", templates: ["a"], selected_templates: [0] },
            { id: "beta", name: "Beta", telegram_token: "tok-beta", templates: ["b"], selected_templates: [0] },
            { id: "gamma", name: "Gamma", telegram_token: "", templates: ["g"], selected_templates: [0] },
        ],
    };
}

function fakeRunnerFactory(started = []) {
    return async (cfg) => {
        const runner = {
            characterId: cfg.character.id,
            stopped: false,
            async start() { started.push(cfg.character.id); return true; },
            stop() { this.stopped = true; },
            touch() {},
            setActivityHook() {},
        };
        return runner;
    };
}

describe("persona polling bridge", () => {
    test("boots with only the active persona polling", async () => {
        const started = [];
        const bridge = new PersonaPollingBridge({
            characterStore: fakeStore(),
            settings: { persona_idle_timeout_minutes: 15 },
            createRunner: fakeRunnerFactory(started),
        });
        const runners = await bridge.startActiveOnly();
        expect(started).toEqual(["alpha"]);
        expect(runners.length).toBe(1);
        expect(bridge.isRunning("alpha")).toBe(true);
        expect(bridge.isRunning("beta")).toBe(false);
        await bridge.stopAll();
    });

    test("wakes another persona on explicit request", async () => {
        const started = [];
        const bridge = new PersonaPollingBridge({
            characterStore: fakeStore(),
            settings: {},
            createRunner: fakeRunnerFactory(started),
        });
        await bridge.startActiveOnly();
        const res = await bridge.ensurePersona("beta", "test-mention");
        expect(res.started).toBe(true);
        expect(bridge.isRunning("beta")).toBe(true);
        const again = await bridge.ensurePersona("beta", "test-mention");
        expect(again.started).toBe(false);
        await bridge.stopAll();
    });

    test("reports no-token personas without starting a poller", async () => {
        const bridge = new PersonaPollingBridge({
            characterStore: fakeStore(),
            settings: {},
            createRunner: fakeRunnerFactory(),
        });
        await bridge.startActiveOnly();
        const res = await bridge.ensurePersona("gamma", "test");
        expect(res.runner).toBe(null);
        expect(res.reason).toBe("no-token");
        await bridge.stopAll();
    });

    test("idle sweeper stops quiet personas but never the active one", async () => {
        const bridge = new PersonaPollingBridge({
            characterStore: fakeStore(),
            settings: { persona_idle_timeout_minutes: 15 },
            createRunner: fakeRunnerFactory(),
        });
        await bridge.startActiveOnly();
        await bridge.ensurePersona("beta", "test");
        // Fake beta idle for 60 minutes, alpha idle for 60 minutes too.
        const hour = 60 * 60 * 1000;
        const now = Date.now();
        bridge.runners.get("beta").lastActivityAt = now - hour;
        bridge.runners.get("alpha").lastActivityAt = now - hour;
        const stopped = bridge.sweepIdle(now);
        expect(stopped.map((s) => s.characterId)).toEqual(["beta"]);
        expect(bridge.isRunning("beta")).toBe(false);
        expect(bridge.isRunning("alpha")).toBe(true);
        await bridge.stopAll();
    });

    test("recent activity protects a persona from the sweeper", async () => {
        const bridge = new PersonaPollingBridge({
            characterStore: fakeStore(),
            settings: { persona_idle_timeout_minutes: 15 },
            createRunner: fakeRunnerFactory(),
        });
        await bridge.startActiveOnly();
        await bridge.ensurePersona("beta", "test");
        bridge.recordActivity("beta");
        const stopped = bridge.sweepIdle(Date.now());
        expect(stopped).toEqual([]);
        expect(bridge.isRunning("beta")).toBe(true);
        await bridge.stopAll();
    });

    test("manual sleep refuses the active persona", async () => {
        const bridge = new PersonaPollingBridge({
            characterStore: fakeStore(),
            settings: {},
            createRunner: fakeRunnerFactory(),
        });
        await bridge.startActiveOnly();
        const refuse = await bridge.sleepPersona("alpha");
        expect(refuse.success).toBe(false);
        await bridge.ensurePersona("beta", "test");
        const ok = await bridge.sleepPersona("beta");
        expect(ok.success).toBe(true);
        expect(bridge.isRunning("beta")).toBe(false);
        await bridge.stopAll();
    });

    test("status lists every persona with polling flags", async () => {
        const bridge = new PersonaPollingBridge({
            characterStore: fakeStore(),
            settings: { persona_idle_timeout_minutes: 15 },
            createRunner: fakeRunnerFactory(),
        });
        await bridge.startActiveOnly();
        const status = bridge.getStatus();
        expect(status.length).toBe(3);
        expect(status.find((r) => r.id === "alpha").polling).toBe(true);
        expect(status.find((r) => r.id === "beta").polling).toBe(false);
        expect(status.find((r) => r.id === "gamma").hasToken).toBe(false);
        expect(bridge.formatStatus()).toContain("Persona Polling Status");
        await bridge.stopAll();
    });
});
