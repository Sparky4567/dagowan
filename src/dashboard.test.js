import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { DashboardServer, shouldStartDashboard, shouldStartAiFriendDash, isAiFriendDashEnabled, resolveDashboardPort, DASHBOARD_DEFAULT_PORT } from "./dashboard.js";
import { lockAllScopes } from "./security.js";

// handleChat persists real sessions (same as the voice bridge tests), so
// back up chat_sessions.json to avoid dirtying repo state on every run.
// Lock tests also persist PIN state via saveSettings, so app_settings.json
// is backed up as well.
const sessionsPath = path.join(process.cwd(), "chat_sessions.json");
const originalSessions = fs.existsSync(sessionsPath) ? fs.readFileSync(sessionsPath) : null;
const settingsPath = path.join(process.cwd(), "app_settings.json");
const originalSettings = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath) : null;
afterAll(() => {
    try {
        lockAllScopes();
    } catch {}
    if (originalSessions) fs.writeFileSync(sessionsPath, originalSessions);
    else if (fs.existsSync(sessionsPath)) fs.unlinkSync(sessionsPath);
    if (originalSettings) fs.writeFileSync(settingsPath, originalSettings);
    else if (fs.existsSync(settingsPath)) fs.unlinkSync(settingsPath);
});

describe("dashboard flag parsing", () => {
    test("starts with --dashboard", () => {
        const r = shouldStartDashboard({}, ["bun", "index.js", "--dashboard"], {});
        expect(r.start).toBe(true);
        expect(r.reason).toBe("flag");
    });

    test("starts with single-dash -dashboard", () => {
        const r = shouldStartDashboard({}, ["bun", "index.js", "-dashboard"], {});
        expect(r.start).toBe(true);
    });

    test("--no-dashboard wins over --dashboard", () => {
        const r = shouldStartDashboard({}, ["bun", "index.js", "--dashboard", "--no-dashboard"], {});
        expect(r.start).toBe(false);
    });

    test("env DASHBOARD_ENABLED=1 starts", () => {
        const r = shouldStartDashboard({}, ["bun", "index.js"], { DASHBOARD_ENABLED: "1" });
        expect(r.start).toBe(true);
        expect(r.reason).toBe("env");
    });

    test("settings.dashboard_enabled starts", () => {
        const r = shouldStartDashboard({ dashboard_enabled: true }, ["bun", "index.js"], {});
        expect(r.start).toBe(true);
    });

    test("off by default", () => {
        const r = shouldStartDashboard({}, ["bun", "index.js"], {});
        expect(r.start).toBe(false);
    });

    test("resolves custom port from --dashboard-port", () => {
        const p = resolveDashboardPort({}, ["--dashboard-port", "8899"], {});
        expect(p).toBe(8899);
    });

    test("resolves port from --dashboard-port= form", () => {
        const p = resolveDashboardPort({}, ["--dashboard-port=8898"], {});
        expect(p).toBe(8898);
    });

    test("defaults to 8768", () => {
        expect(resolveDashboardPort({}, [], {})).toBe(DASHBOARD_DEFAULT_PORT);
        expect(DASHBOARD_DEFAULT_PORT).toBe(8768);
    });

    test("--aifrienddash implies the dashboard", () => {
        const r = shouldStartDashboard({}, ["bun", "index.js", "--aifrienddash"], {});
        expect(r.start).toBe(true);
        expect(r.reason).toBe("aifrienddash-flag");
    });
});

describe("aifrienddash flag parsing", () => {
    test("starts with --aifrienddash", () => {
        const r = shouldStartAiFriendDash({}, ["bun", "index.js", "--aifrienddash"], {});
        expect(r.enabled).toBe(true);
        expect(r.reason).toBe("flag");
    });

    test("starts with single-dash -aifrienddash", () => {
        const r = shouldStartAiFriendDash({}, ["bun", "index.js", "-aifrienddash"], {});
        expect(r.enabled).toBe(true);
    });

    test("--no-aifrienddash wins over --aifrienddash", () => {
        const r = shouldStartAiFriendDash({}, ["bun", "index.js", "--aifrienddash", "--no-aifrienddash"], {});
        expect(r.enabled).toBe(false);
        expect(r.reason).toBe("disabled-flag");
    });

    test("env AIFRIENDDASH_ENABLED=1 starts", () => {
        const r = shouldStartAiFriendDash({}, ["bun", "index.js"], { AIFRIENDDASH_ENABLED: "1" });
        expect(r.enabled).toBe(true);
        expect(r.reason).toBe("env");
    });

    test("settings.aifrienddash_enabled starts", () => {
        const r = shouldStartAiFriendDash({ aifrienddash_enabled: true }, ["bun", "index.js"], {});
        expect(r.enabled).toBe(true);
        expect(r.reason).toBe("settings");
    });

    test("off by default", () => {
        expect(isAiFriendDashEnabled({}, ["bun", "index.js"], {})).toBe(false);
    });

    test("--no-dashboard wins over --aifrienddash", () => {
        const r = shouldStartDashboard({}, ["bun", "index.js", "--aifrienddash", "--no-dashboard"], {});
        expect(r.start).toBe(false);
    });
});

describe("aifrienddash routes", () => {
    function dashServer(settings = {}) {
        return new DashboardServer({
            settings: { model: "test-model", server_url: "http://127.0.0.1:11434", mem_limit: 4, auto_learning_enabled: false, ...settings },
            characterStore: {
                active_character: "main",
                characters: [{ id: "main", name: "Main", model: "m", templates: ["Be helpful"], selected_templates: [0] }],
            },
            services: {
                unifiedChat: async () => ({ content: "hello from llm" }),
            },
        });
    }

    test("/api/aifrienddash-status reflects the gate", async () => {
        const on = dashServer({ aifrienddash_enabled: true });
        const resOn = await on.handleRequest(new Request("http://localhost/api/aifrienddash-status"));
        expect(resOn.status).toBe(200);
        expect((await resOn.json()).enabled).toBe(true);
        const off = dashServer({});
        const resOff = await off.handleRequest(new Request("http://localhost/api/aifrienddash-status"));
        expect((await resOff.json()).enabled).toBe(false);
    });

    test("/aifrienddash serves HTML when enabled, 404 when disabled", async () => {
        const on = dashServer({ aifrienddash_enabled: true });
        const page = await on.handleRequest(new Request("http://localhost/aifrienddash"));
        expect(page.status).toBe(200);
        expect(page.headers.get("content-type")).toContain("text/html");
        const html = await page.text();
        expect(html).toContain("AI bud pro");
        expect(html).toContain("/api/chat");
        const off = dashServer({});
        const missing = await off.handleRequest(new Request("http://localhost/aifrienddash"));
        expect(missing.status).toBe(404);
    });

    test("/api/health reports aifrienddash", async () => {
        const s = dashServer({ aifrienddash_enabled: true });
        const res = await s.handleRequest(new Request("http://localhost/api/health"));
        expect((await res.json()).aifrienddash).toBe(true);
    });
});

describe("dashboard chat", () => {
    function server() {
        return new DashboardServer({
            settings: { model: "test-model", server_url: "http://127.0.0.1:11434", mem_limit: 4, auto_learning_enabled: false },
            characterStore: {
                active_character: "main",
                characters: [{ id: "main", name: "Main", model: "m", templates: ["Be helpful"], selected_templates: [0] }],
            },
            services: {
                unifiedChat: async () => ({ content: "hello from llm" }),
            },
        });
    }

    test("@help answers without LLM", async () => {
        let calls = 0;
        const s = server();
        s.services.unifiedChat = async () => {
            calls += 1;
            return { content: "nope" };
        };
        const res = await s.handleChat({ message: "@help" });
        expect(res.command).toBe(true);
        expect(res.reply).toContain("@remember");
        expect(calls).toBe(0);
    });

    test("@stats answers without LLM", async () => {
        const s = server();
        const res = await s.handleChat({ message: "@stats" });
        expect(res.reply).toContain("Persistent Learning");
    });

    test("@play without query answers with usage (no LLM call)", async () => {
        let calls = 0;
        const s = server();
        s.services.unifiedChat = async () => {
            calls += 1;
            return { content: "nope" };
        };
        const res = await s.handleChat({ message: "@play" });
        expect(res.command).toBe(true);
        expect(res.reply).toContain("Usage: @youtube-play");
        expect(calls).toBe(0);
    });

    test("@spotify-play without query answers with usage (no LLM call)", async () => {
        let calls = 0;
        const s = server();
        s.services.unifiedChat = async () => {
            calls += 1;
            return { content: "nope" };
        };
        const res = await s.handleChat({ message: "@spotify-play" });
        expect(res.command).toBe(true);
        expect(res.reply).toContain("Usage: @spotify-play");
        expect(calls).toBe(0);
    });

    test("@make without prompt answers with usage (no LLM call)", async () => {
        let calls = 0;
        const s = server();
        s.services.unifiedChat = async () => {
            calls += 1;
            return { content: "nope" };
        };
        const res = await s.handleChat({ message: "@make" });
        expect(res.command).toBe(true);
        expect(res.reply).toContain("Usage: @make");
        expect(calls).toBe(0);
    });

    test("@fact-check without claim answers with usage (no LLM call)", async () => {
        let calls = 0;
        const s = server();
        s.services.unifiedChat = async () => {
            calls += 1;
            return { content: "nope" };
        };
        const res = await s.handleChat({ message: "@fact-check" });
        expect(res.command).toBe(true);
        expect(res.reply).toContain("Usage: @fact-check");
        expect(calls).toBe(0);
    });

    test("@blog without topic answers with usage (no LLM call)", async () => {
        let calls = 0;
        const s = server();
        s.services.unifiedChat = async () => {
            calls += 1;
            return { content: "nope" };
        };
        const res = await s.handleChat({ message: "@blog" });
        expect(res.command).toBe(true);
        expect(res.reply).toContain("Usage: @blog");
        expect(calls).toBe(0);
    });

    test("@lock/@unlock round-trip on the web surface", async () => {
        try {
            const s = server();
            let calls = 0;
            s.services.unifiedChat = async () => {
                calls += 1;
                return { content: "hello from llm" };
            };
            const setRes = await s.handleChat({ message: "@set-security-pin 482916" });
            expect(setRes.command).toBe(true);
            expect(setRes.reply).toContain("Security PIN set");
            await s.handleChat({ message: "@lock" });
            const blocked = await s.handleChat({ message: "@stats" });
            expect(blocked.command).toBe(true);
            expect(blocked.reply).toMatch(/Locked|OTP required/);
            expect(calls).toBe(0);
            const plain = await s.handleChat({ message: "hello while locked" });
            expect(plain.command).toBe(false);
            expect(calls).toBe(1);
            const unlocked = await s.handleChat({ message: "@unlock 482916" });
            expect(unlocked.reply).toMatch(/Unlocked/);
            const after = await s.handleChat({ message: "@stats" });
            expect(after.reply).toContain("Persistent Learning");
        } finally {
            lockAllScopes();
        }
    });

    test("mutating REST endpoints refuse while web is locked", async () => {
        try {
            const s = server();
            await s.handleChat({ message: "@set-security-pin 482916" });
            await s.handleChat({ message: "@lock" });
            const res = await s.handleRequest(
                new Request("http://localhost/api/settings", {
                    method: "POST",
                    body: JSON.stringify({ settings: { model: "x" } }),
                })
            );
            expect(res.status).toBe(423);
            const status = await s.handleRequest(new Request("http://localhost/api/security-status"));
            const body = await status.json();
            expect(body.locked).toBe(true);
            expect(body.scope).toBe("web");
        } finally {
            lockAllScopes();
        }
    });

    test("plain chat reaches the LLM and persists a session", async () => {
        const s = server();
        const res = await s.handleChat({ message: "hello dashboard" });
        expect(res.command).toBe(false);
        expect(res.reply).toBe("hello from llm");
        expect(res.sessionId).toBeTruthy();
    });

    test("empty message throws", async () => {
        const s = server();
        let err = null;
        try {
            await s.handleChat({ message: "   " });
        } catch (e) {
            err = e;
        }
        expect(err).toBeTruthy();
    });
});

describe("dashboard server idle timeout (local TTS regression)", () => {
    test("/api/tts survives slow local synthesis (>10s, no empty reply)", async () => {
        const port = 18927;
        const s = new DashboardServer({
            settings: { model: "test-model", server_url: "http://127.0.0.1:11434", tts_engine: "local" },
            characterStore: {
                active_character: "main",
                characters: [{ id: "main", name: "Main", model: "m", templates: ["Be helpful"], selected_templates: [0] }],
            },
            services: {
                unifiedChat: async () => ({ content: "hi" }),
                // Local MMS-TTS takes ~20s+ per reply on CPU; Bun's default
                // ~10s idle timeout used to close the connection with an
                // empty reply (Chrome: net::ERR_EMPTY_RESPONSE), leaving the
                // avatar silent. The stub simulates that slowness.
                synthesizeSpeech: async (text, outPath) => {
                    await new Promise((r) => setTimeout(r, 12000));
                    fs.writeFileSync(outPath, Buffer.from([82, 73, 70, 70, 1, 2, 3, 4]));
                    return { audioPath: outPath };
                },
            },
        });
        s.start(port);
        try {
            const res = await fetch(`http://127.0.0.1:${port}/api/tts`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ text: "hello", engine: "local" }),
            });
            expect(res.status).toBe(200);
            expect(res.headers.get("content-type")).toContain("audio/wav");
            const buf = Buffer.from(await res.arrayBuffer());
            expect(buf.length).toBe(8);
        } finally {
            s.stop();
        }
    }, 60000);
});
