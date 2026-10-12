import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { LocalVoiceSocketBridge } from "./voice_socket.js";

const sessionsPath = path.join(process.cwd(), "chat_sessions.json");
const originalSessions = fs.existsSync(sessionsPath) ? fs.readFileSync(sessionsPath) : null;

function mockSocket() {
    return {
        readyState: 1,
        sent: [],
        send(payload) { this.sent.push(JSON.parse(payload)); },
    };
}

describe("voice web bridge", () => {
    afterAll(() => {
        if (originalSessions) fs.writeFileSync(sessionsPath, originalSessions);
        else if (fs.existsSync(sessionsPath)) fs.unlinkSync(sessionsPath);
    });

    function bridge() {
        return new LocalVoiceSocketBridge({
            settings: { model: "shared-test-model", auto_learning_enabled: false, stt_engine: "local", tts_engine: "local" },
            characterStore: { active_character: "main", characters: [{ id: "main", name: "Main", model: "different-persona-model", templates: ["Be helpful"], selected_templates: [0] }] },
            services: {
                transcribeAudio: async () => ({ text: "voice recording transcript" }),
                unifiedChat: async ({ modelName }) => ({ content: `reply from ${modelName}` }),
                synthesizeSpeech: async (_text, outputPath) => {
                    fs.writeFileSync(outputPath, Buffer.from("RIFFmockWAVE"));
                    return { audioPath: outputPath };
                },
            },
        });
    }

    test("processes written material with the shared model and emits speech", async () => {
        const ws = mockSocket();
        await bridge().processTextQuery(ws, "summarize this written material", "text-test");
        expect(ws.sent.some((event) => event.event === "llm_complete" && event.text === "reply from shared-test-model")).toBe(true);
        expect(ws.sent.some((event) => event.event === "tts_audio" && event.format === "wav")).toBe(true);
    });

    test("processes a voice recording through transcription, chat, and speech", async () => {
        const ws = mockSocket();
        await bridge().processVoiceQuery(ws, Buffer.from("fake audio recording").toString("base64"), "audio/webm", "voice-test");
        expect(ws.sent.some((event) => event.event === "stt_transcript" && event.text === "voice recording transcript")).toBe(true);
        expect(ws.sent.some((event) => event.event === "llm_complete" && event.text === "reply from shared-test-model")).toBe(true);
        expect(ws.sent.some((event) => event.event === "tts_audio")).toBe(true);
    });

    // Regression: interrupting speak-back must not kill the next prompt.
    // The old shared-boolean flag let a stale interrupt silently drop the
    // following query (bot got the prompt, UI never answered).
    describe("interrupt recovery", () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

        function controllableBridge({ hangLlmCalls = [], hangTtsCalls = [] } = {}) {
            let llmCalls = 0;
            let ttsCalls = 0;
            let releaseLlm = null;
            let releaseTts = null;
            const llmGate = new Promise((r) => { releaseLlm = r; });
            const ttsGate = new Promise((r) => { releaseTts = r; });
            const b = new LocalVoiceSocketBridge({
                settings: { model: "shared-test-model", auto_learning_enabled: false, stt_engine: "local", tts_engine: "local" },
                characterStore: { active_character: "main", characters: [{ id: "main", name: "Main", model: "m", templates: ["Be helpful"], selected_templates: [0] }] },
                services: {
                    transcribeAudio: async () => ({ text: "hello" }),
                    unifiedChat: async () => {
                        llmCalls += 1;
                        if (hangLlmCalls.includes(llmCalls)) await llmGate;
                        return { content: `reply${llmCalls}` };
                    },
                    synthesizeSpeech: async (_text, outputPath) => {
                        ttsCalls += 1;
                        if (hangTtsCalls.includes(ttsCalls)) await ttsGate;
                        fs.writeFileSync(outputPath, Buffer.from("RIFFmockWAVE"));
                        return { audioPath: outputPath };
                    },
                },
            });
            return { bridge: b, releaseLlm, releaseTts };
        }

        test("prompt sent after an interrupt still gets an answer", async () => {
            const { bridge } = controllableBridge();
            const ws = mockSocket();
            await bridge.processTextQuery(ws, "first turn", "irq-after");
            bridge.interruptTurn(ws); // user hits Intercept after the answer
            await bridge.processTextQuery(ws, "second turn", "irq-after");
            const answers = ws.sent.filter((e) => e.event === "llm_complete" && /^reply\d/.test(e.text));
            expect(answers.length).toBe(2);
            expect(ws.sent.some((e) => e.event === "tts_audio")).toBe(true);
        });

        test("interrupted in-flight turn un-sticks the UI instead of silent drop", async () => {
            const { bridge, releaseLlm } = controllableBridge({ hangLlmCalls: [1] });
            const ws = mockSocket();
            const pending = bridge.processTextQuery(ws, "slow turn", "irq-mid");
            await sleep(30); // let the turn reach the LLM await
            bridge.interruptTurn(ws); // user interrupts while thinking
            releaseLlm();
            await pending;
            expect(ws.sent.some((e) => e.event === "state_change" && e.state === "idle")).toBe(true);
            expect(ws.sent.some((e) => e.event === "llm_complete" && e.text === "⏸ Interrupted.")).toBe(true);
        });

        test("superseded turn aborts silently, newer turn answers", async () => {
            const { bridge, releaseLlm } = controllableBridge({ hangLlmCalls: [1] });
            const ws = mockSocket();
            const pendingA = bridge.processTextQuery(ws, "old turn", "irq-overlap");
            await sleep(30); // A is inside the LLM await
            bridge.interruptTurn(ws); // user interrupts A's speak-back...
            const pendingB = bridge.processTextQuery(ws, "new turn", "irq-overlap"); // ...and asks again
            releaseLlm();
            await Promise.all([pendingA, pendingB]);
            expect(ws.sent.some((e) => e.event === "llm_complete" && e.text === "reply2")).toBe(true);
            expect(ws.sent.some((e) => e.event === "llm_complete" && e.text === "reply1")).toBe(false);
        });

        test("TTS interrupted mid-synthesis resets to idle without audio", async () => {
            const { bridge, releaseTts } = controllableBridge({ hangTtsCalls: [1] });
            const ws = mockSocket();
            const pending = bridge.processTextQuery(ws, "say it", "irq-tts");
            await sleep(50); // let the turn reach TTS synthesis
            bridge.interruptTurn(ws);
            releaseTts();
            await pending;
            expect(ws.sent.some((e) => e.event === "llm_complete" && e.text === "reply1")).toBe(true);
            expect(ws.sent.some((e) => e.event === "tts_audio")).toBe(false);
            expect(ws.sent.filter((e) => e.event === "state_change").at(-1)?.state).toBe("idle");
        });

        test("sequential prompts each get an answer (no silent second prompt)", async () => {
            const { bridge } = controllableBridge();
            const ws = mockSocket();
            await bridge.processTextQuery(ws, "first", "seq-prompts");
            await bridge.processTextQuery(ws, "second", "seq-prompts");
            const answers = ws.sent.filter((e) => e.event === "llm_complete" && /^reply\d/.test(e.text));
            expect(answers.length).toBe(2);
        });

        test("browser TTS mode skips server synthesis and still answers", async () => {
            let synthCalls = 0;
            const b = new LocalVoiceSocketBridge({
                settings: { model: "shared-test-model", auto_learning_enabled: false, stt_engine: "local", tts_engine: "browser" },
                characterStore: { active_character: "main", characters: [{ id: "main", name: "Main", model: "m", templates: ["Be helpful"], selected_templates: [0] }] },
                services: {
                    transcribeAudio: async () => ({ text: "hello" }),
                    unifiedChat: async () => ({ content: "spoken reply" }),
                    synthesizeSpeech: async (_text, outputPath) => {
                        synthCalls += 1;
                        fs.writeFileSync(outputPath, Buffer.from("RIFFmockWAVE"));
                        return { audioPath: outputPath };
                    },
                },
            });
            const ws = mockSocket();
            await b.processTextQuery(ws, "hello", "browser-tts");
            await b.processTextQuery(ws, "again", "browser-tts");
            expect(synthCalls).toBe(0);
            expect(ws.sent.some((e) => e.event === "tts_audio")).toBe(false);
            const answers = ws.sent.filter((e) => e.event === "llm_complete");
            expect(answers.length).toBe(2);
            expect(ws.sent.filter((e) => e.event === "state_change").at(-1)?.state).toBe("idle");
        });

        test("failing second prompt delivers an error instead of silence", async () => {
            let calls = 0;
            const b = new LocalVoiceSocketBridge({
                settings: { model: "shared-test-model", auto_learning_enabled: false, stt_engine: "local", tts_engine: "local" },
                characterStore: { active_character: "main", characters: [{ id: "main", name: "Main", model: "m", templates: ["Be helpful"], selected_templates: [0] }] },
                services: {
                    transcribeAudio: async () => ({ text: "hello" }),
                    unifiedChat: async () => {
                        calls += 1;
                        if (calls === 2) throw new Error("boom");
                        return { content: `reply${calls}` };
                    },
                    synthesizeSpeech: async (_text, outputPath) => {
                        fs.writeFileSync(outputPath, Buffer.from("RIFFmockWAVE"));
                        return { audioPath: outputPath };
                    },
                },
            });
            const ws = mockSocket();
            await b.processTextQuery(ws, "first", "fail-second");
            await b.processTextQuery(ws, "second", "fail-second");
            const answers = ws.sent.filter((e) => e.event === "llm_complete");
            expect(answers.length).toBe(2);
            expect(answers[1].text).toMatch(/Error: boom/);
        });

        test("superseded turn skips synthesis without calling TTS", async () => {
            let synthCalls = 0;
            const b = new LocalVoiceSocketBridge({
                settings: { model: "shared-test-model", auto_learning_enabled: false, stt_engine: "local", tts_engine: "local" },
                characterStore: { active_character: "main", characters: [{ id: "main", name: "Main", model: "m", templates: ["Be helpful"], selected_templates: [0] }] },
                services: {
                    transcribeAudio: async () => ({ text: "hello" }),
                    unifiedChat: async () => ({ content: "reply" }),
                    synthesizeSpeech: async (_text, outputPath) => {
                        synthCalls += 1;
                        fs.writeFileSync(outputPath, Buffer.from("RIFFmockWAVE"));
                        return { audioPath: outputPath };
                    },
                },
            });
            const ws = mockSocket();
            const myTurn = b.nextTurn(ws); // turn 1 in flight
            b.interruptTurn(ws); // user interrupts before TTS starts
            b.nextTurn(ws); // turn 2 owns the UI now
            await b.speakReply(ws, "stale reply", myTurn);
            expect(synthCalls).toBe(0);
        });
    });

    // Regression: @ tool commands must execute on the web bridge (side
    // panel / voice UI) instead of falling through to the LLM as chat.
    // Previously only @help/@opencli/@opencode/simulation were dispatched,
    // so e.g. @youtube-play "did nothing" from the Chrome side panel.
    describe("web @ command dispatch", () => {
        function countingBridge() {
            let llmCalls = 0;
            const b = new LocalVoiceSocketBridge({
                settings: { model: "shared-test-model", auto_learning_enabled: false, stt_engine: "local", tts_engine: "local" },
                characterStore: { active_character: "main", characters: [{ id: "main", name: "Main", model: "m", templates: ["Be helpful"], selected_templates: [0] }] },
                services: {
                    transcribeAudio: async () => ({ text: "hello" }),
                    unifiedChat: async () => { llmCalls += 1; return { content: "should not be used for commands" }; },
                    synthesizeSpeech: async (_text, outputPath) => {
                        fs.writeFileSync(outputPath, Buffer.from("RIFFmockWAVE"));
                        return { audioPath: outputPath };
                    },
                },
            });
            return { bridge: b, llmCalls: () => llmCalls };
        }

        function replyOf(ws) {
            const msgs = ws.sent.filter((e) => e.event === "llm_complete");
            return msgs.length > 0 ? msgs[msgs.length - 1].text : "";
        }

        test("@youtube-play without query answers with usage (no LLM call)", async () => {
            const { bridge, llmCalls } = countingBridge();
            const ws = mockSocket();
            await bridge.processTextQuery(ws, "@youtube-play", "cmd-yt-usage");
            expect(replyOf(ws)).toContain("Usage: @youtube-play");
            expect(llmCalls()).toBe(0);
            expect(ws.sent.some((e) => e.event === "tts_audio")).toBe(false);
        });

        test("@blog without topic answers with usage (no LLM call)", async () => {
            const { bridge, llmCalls } = countingBridge();
            const ws = mockSocket();
            await bridge.processTextQuery(ws, "@blog", "cmd-blog-usage");
            expect(replyOf(ws)).toContain("Usage: @blog");
            expect(llmCalls()).toBe(0);
        });

        test("@make without prompt answers with usage (no LLM call)", async () => {
            const { bridge, llmCalls } = countingBridge();
            const ws = mockSocket();
            await bridge.processTextQuery(ws, "@make", "cmd-make-usage");
            expect(replyOf(ws)).toContain("Usage: @make");
            expect(llmCalls()).toBe(0);
        });

        test("@fact-check without claim answers with usage (no LLM call)", async () => {
            const { bridge, llmCalls } = countingBridge();
            const ws = mockSocket();
            await bridge.processTextQuery(ws, "@fact-check", "cmd-fc-usage");
            expect(replyOf(ws)).toContain("Usage: @fact-check");
            expect(llmCalls()).toBe(0);
        });

        test("@get-tasks executes instead of chatting", async () => {
            const { bridge, llmCalls } = countingBridge();
            const ws = mockSocket();
            await bridge.processTextQuery(ws, "@get-tasks", "cmd-tasks");
            expect(replyOf(ws)).toContain("📋");
            expect(llmCalls()).toBe(0);
        });

        test("@stats executes instead of chatting", async () => {
            const { bridge, llmCalls } = countingBridge();
            const ws = mockSocket();
            await bridge.processTextQuery(ws, "@stats", "cmd-stats");
            expect(replyOf(ws)).toContain("Persistent Learning");
            expect(llmCalls()).toBe(0);
        });

        test("@sessions executes instead of chatting", async () => {
            const { bridge, llmCalls } = countingBridge();
            const ws = mockSocket();
            await bridge.processTextQuery(ws, "@sessions", "cmd-sessions");
            expect(replyOf(ws)).toMatch(/Saved Sessions|No saved sessions/);
            expect(llmCalls()).toBe(0);
        });

        test("@help renders the live unlock duration", async () => {
            const { bridge, llmCalls } = countingBridge();
            const ws = mockSocket();
            await bridge.processTextQuery(ws, "@help", "cmd-help");
            expect(replyOf(ws)).toContain("security_unlock_minutes=10");
            expect(llmCalls()).toBe(0);
        });

        test("plain chat still reaches the LLM", async () => {
            const { bridge, llmCalls } = countingBridge();
            const ws = mockSocket();
            await bridge.processTextQuery(ws, "hello there", "cmd-chat");
            expect(replyOf(ws)).toBe("should not be used for commands");
            expect(llmCalls()).toBe(1);
        });
    });

});
