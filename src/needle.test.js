import { describe, expect, test } from "bun:test";
import {
    NEEDLE_DEFAULT_TOOLS,
    createDaemonClient,
    executeNeedleCall,
    formatNeedleExtractResult,
    formatNeedleRouteResult,
    getNeedleDaemonIdleMs,
    getNeedleMinConfidence,
    getNeedlePython,
    isNeedleAutoRoutingEnabled,
    isNeedleFastPathCandidate,
    isTrivialTurn,
    parseNeedleInput,
    routeWithNeedle,
    runNeedleBridge,
    splitSchemaAndText,
    tryNeedleFastPath,
} from "./needle.js";

describe("needle command parsing", () => {
    test("routes @needle variants, null for other commands", () => {
        expect(parseNeedleInput("@needle remember I like tea")).toEqual({
            action: "route",
            text: "remember I like tea",
        });
        expect(parseNeedleInput("/needle remember x")?.action).toBe("route");
        expect(parseNeedleInput("@needle-status")?.action).toBe("status");
        expect(parseNeedleInput("@needle-tools")?.action).toBe("tools");
        expect(parseNeedleInput("@needle-embed hello")?.action).toBe("embed");
        expect(parseNeedleInput("@fact-check x")).toBeNull();
        expect(parseNeedleInput("hello")).toBeNull();
    });

    test("splits extract schema from trailing text", () => {
        const parsed = parseNeedleInput(
            '@needle-extract {"type":"object","properties":{"total":{"type":"number"}}} Invoice total $12'
        );
        expect(parsed?.action).toBe("extract");
        expect(parsed?.schema).toEqual({
            type: "object",
            properties: { total: { type: "number" } },
        });
        expect(parsed?.text).toBe("Invoice total $12");
    });

    test("splitSchemaAndText tolerates braces inside strings", () => {
        const { schema, text } = splitSchemaAndText('{"a": "x}y"} trailing');
        expect(schema).toEqual({ a: "x}y" });
        expect(text).toBe("trailing");
    });

    test("splitSchemaAndText returns null schema without JSON", () => {
        expect(splitSchemaAndText("no json here").schema).toBeNull();
    });
});

describe("needle settings", () => {
    test("python / confidence / auto-routing resolve with env fallback", () => {
        expect(getNeedlePython({})).toBe("python3");
        expect(getNeedlePython({ needle_python: "/usr/bin/python" })).toBe("/usr/bin/python");
        expect(getNeedleMinConfidence({})).toBe(0.7);
        expect(getNeedleMinConfidence({ needle_min_confidence: 2 })).toBe(1);
        expect(getNeedleMinConfidence({ needle_min_confidence: "bad" })).toBe(0.7);
        expect(isNeedleAutoRoutingEnabled({})).toBe(false);
        expect(isNeedleAutoRoutingEnabled({ needle_enabled: true })).toBe(true);
    });

    test("default tool catalog stays small (retrieval head renders all)", () => {
        expect(NEEDLE_DEFAULT_TOOLS.length).toBeLessThanOrEqual(5);
        for (const t of NEEDLE_DEFAULT_TOOLS) {
            expect(typeof t.name).toBe("string");
            expect(t.parameters?.type).toBe("object");
        }
    });
});

describe("needle result formatting", () => {
    test("empty calls is a refusal, not an error", () => {
        const out = formatNeedleRouteResult({ success: true, function_calls: [] }, {});
        expect(out).toMatch(/no local tool covers/);
    });

    test("below-threshold calls ask for confirmation", () => {
        const out = formatNeedleRouteResult(
            {
                success: true,
                function_calls: [{ name: "remember_memory", arguments: { text: "x" } }],
                confidence: 0.2,
                reasoning: "r",
            },
            { needle_min_confidence: 0.7 }
        );
        expect(out).toMatch(/confirm/);
        expect(out).toMatch(/0\.20/);
    });

    test("missing package maps to install hint", () => {
        const out = formatNeedleRouteResult({ success: false, error: "No module named 'needle'" }, {});
        expect(out).toMatch(/pip install cactus-needle/);
    });

    test("extraction refusal invents nothing", () => {
        expect(
            formatNeedleExtractResult({ success: true, result: null, refused: true })
        ).toMatch(/nothing matched/);
        expect(
            formatNeedleExtractResult({ success: true, result: { total: 12 } })
        ).toContain('"total": 12');
    });
});

describe("needle bridge runner", () => {
    test("spawn errors surface as bridge errors", async () => {
        const res = await runNeedleBridge(
            { mode: "status" },
            {},
            async () => {
                throw new Error("no python");
            }
        );
        expect(res.success).toBe(false);
        expect(res.error).toMatch(/no python/);
    });

    test("injectable spawnFn is used verbatim (no python needed)", async () => {
        const fake = async () => ({
            success: true,
            function_calls: [{ name: "register_task", arguments: { description: "buy milk" } }],
            confidence: 0.95,
        });
        const res = await runNeedleBridge({ mode: "complete", text: "x" }, {}, fake);
        expect(res.function_calls[0].name).toBe("register_task");
    });
});

describe("needle fast-path gate", () => {
    test("broad recall, skips commands/chitchat/pastes", () => {
        expect(isNeedleFastPathCandidate("remember that I prefer oat milk")).toBe(true);
        expect(isNeedleFastPathCandidate("add a task to buy milk")).toBe(true);
        expect(isNeedleFastPathCandidate("I prefer window seats")).toBe(true);
        expect(isNeedleFastPathCandidate("remind me to call mom at 5")).toBe(true);
        expect(isNeedleFastPathCandidate("@remember x")).toBe(false);
        expect(isNeedleFastPathCandidate("/tasks")).toBe(false);
        expect(isNeedleFastPathCandidate("ok")).toBe(false);
        expect(isNeedleFastPathCandidate("thanks!")).toBe(false);
        expect(isNeedleFastPathCandidate("what is the capital of Peru?")).toBe(false);
        expect(isNeedleFastPathCandidate("tell me a joke")).toBe(false);
        expect(isNeedleFastPathCandidate("write a poem about the sea")).toBe(false);
        expect(isNeedleFastPathCandidate("```code``` fix this")).toBe(false);
        expect(isNeedleFastPathCandidate("x".repeat(501))).toBe(false);
    });

    test("trivial-turn triage for background learning", () => {
        expect(isTrivialTurn("")).toBe(true);
        expect(isTrivialTurn("ok")).toBe(true);
        expect(isTrivialTurn("thanks!")).toBe(true);
        expect(isTrivialTurn("my dog died")).toBe(false);
        expect(isTrivialTurn("I quit my job today")).toBe(false);
    });

    test("daemon idle setting clamps bad values", () => {
        expect(getNeedleDaemonIdleMs({})).toBe(300000);
        expect(getNeedleDaemonIdleMs({ needle_daemon_idle_ms: 1000 })).toBe(1000);
        expect(getNeedleDaemonIdleMs({ needle_daemon_idle_ms: -5 })).toBe(300000);
    });
});

describe("needle shared executor (pure paths)", () => {
    test("unknown tools and empty args never touch stores", async () => {
        expect(await executeNeedleCall({ name: "nope", arguments: {} }, {})).toMatch(/Unknown/);
        expect(await executeNeedleCall({ name: "remember_memory", arguments: {} }, {})).toMatch(/skipped/);
        expect(await executeNeedleCall({ name: "register_task", arguments: {} }, {})).toMatch(/skipped/);
        expect(await executeNeedleCall({ name: "save_note", arguments: { title: "t" } }, {})).toMatch(/skipped/);
        expect(await executeNeedleCall({ name: "set_proactive_timer", arguments: { minutes: 0 } }, {})).toMatch(/skipped/);
    });
});

describe("needle fast-path orchestration (injected deps, no python)", () => {
    const ctx = (enabled = true) => ({ settings: { needle_enabled: enabled, needle_min_confidence: 0.7 } });
    const call = { name: "register_task", arguments: { description: "buy milk" } };

    test("disabled flag never routes", async () => {
        let routed = false;
        const res = await tryNeedleFastPath("add a task", ctx(false), {
            routeFn: async () => { routed = true; return {}; },
        });
        expect(res.handled).toBe(false);
        expect(routed).toBe(false);
    });

    test("non-candidates never route", async () => {
        let routed = false;
        const res = await tryNeedleFastPath("what is the capital of Peru?", ctx(true), {
            routeFn: async () => { routed = true; return {}; },
        });
        expect(res.handled).toBe(false);
        expect(routed).toBe(false);
    });

    test("confident calls execute and reply", async () => {
        const executed = [];
        const res = await tryNeedleFastPath("add a task to buy milk", ctx(true), {
            routeFn: async () => ({ success: true, function_calls: [call], confidence: 0.95 }),
            executeFn: async (c) => { executed.push(c.name); return `did ${c.name}`; },
        });
        expect(res.handled).toBe(true);
        expect(res.reply).toBe("did register_task");
        expect(executed).toEqual(["register_task"]);
    });

    test("refusals and low confidence fall through to the LLM", async () => {
        const refused = await tryNeedleFastPath("remind me of nothing", ctx(true), {
            routeFn: async () => ({ success: true, function_calls: [], confidence: 0.9 }),
        });
        expect(refused.handled).toBe(false);
        const unsure = await tryNeedleFastPath("maybe add a task?", ctx(true), {
            routeFn: async () => ({ success: true, function_calls: [call], confidence: 0.1 }),
        });
        expect(unsure.handled).toBe(false);
        const broken = await tryNeedleFastPath("add a task", ctx(true), {
            routeFn: async () => ({ success: false, error: "boom" }),
        });
        expect(broken.handled).toBe(false);
    });

    test("routeWithNeedle uses one-shot spawn when auto-routing is off", async () => {
        const res = await routeWithNeedle(
            "hello",
            { needle_enabled: false },
            {},
            { spawnFn: async () => ({ success: true, function_calls: [] }) }
        );
        expect(res.success).toBe(true);
    });
});

// Minimal in-process fake of a stdio child for daemon protocol tests.
function makeFakeDaemon({ respond = null, crashOnWrite = false } = {}) {
    const handlers = { stdout: [], stderr: [], error: [], close: [] };
    const writes = [];
    const proc = {
        pid: 4242,
        stdin: {
            write: (data) => {
                writes.push(String(data));
                if (crashOnWrite) {
                    queueMicrotask(() => handlers.close.forEach((fn) => fn(1)));
                    return;
                }
                const req = JSON.parse(String(data));
                const res = respond
                    ? respond(req)
                    : { id: req.id, success: true, function_calls: [], confidence: 1 };
                queueMicrotask(() => {
                    handlers.stdout.forEach((fn) => fn(JSON.stringify(res) + "\n"));
                });
            },
        },
        stdout: { on: (ev, fn) => { handlers.stdout.push(fn); } },
        stderr: { on: () => {} },
        on: (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn); },
        kill: () => { handlers.close.forEach((fn) => fn(0)); },
        _writes: writes,
    };
    return proc;
}

describe("needle daemon client (fake stdio, no python)", () => {
    test("matches responses by id, supports concurrent requests", async () => {
        const daemon = createDaemonClient({ spawnDaemon: () => makeFakeDaemon(), idleMs: 0 });
        const [a, b] = await Promise.all([
            daemon.request("python3", "x.py", { mode: "complete", text: "one" }),
            daemon.request("python3", "x.py", { mode: "complete", text: "two" }),
        ]);
        expect(a.success).toBe(true);
        expect(b.success).toBe(true);
        expect(daemon.status().running).toBe(true);
        daemon.stop();
        expect(daemon.status().running).toBe(false);
    });

    test("crash rejects pending and allows restart", async () => {
        let procs = 0;
        const daemon = createDaemonClient({
            spawnDaemon: () => { procs++; return makeFakeDaemon({ crashOnWrite: procs === 1 }); },
            idleMs: 0,
        });
        await expect(daemon.request("python3", "x.py", { mode: "x" })).rejects.toThrow();
        const retry = await daemon.request("python3", "x.py", { mode: "complete", text: "hi" });
        expect(retry.success).toBe(true);
        expect(procs).toBe(2);
        daemon.stop();
    });

    test("idle shutdown frees the process", async () => {
        let killed = false;
        const proc = makeFakeDaemon();
        const origKill = proc.kill;
        proc.kill = (...a) => { killed = true; return origKill(...a); };
        const daemon = createDaemonClient({ spawnDaemon: () => proc, idleMs: 30 });
        await daemon.request("python3", "x.py", { mode: "status" });
        await new Promise((r) => setTimeout(r, 120));
        expect(killed).toBe(true);
        expect(daemon.status().running).toBe(false);
    });
});
