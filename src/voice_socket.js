import fs from "node:fs";
import path from "node:path";
import ollama from "ollama";
import { unifiedChat } from "./providers.js";
import { transcribeAudioLocal, synthesizeSpeechLocal } from "./audio.js";
import { loadSettings, saveSettings } from "./config.js";
import { loadCharacterStore, getActiveCharacter, composeSystemTemplate } from "./characters.js";
import { loadSession, createSession, saveSession, retrieveSessionContext } from "./sessions.js";
import { loadMemories, retrieveMemories } from "./memory.js";
import { COMMANDS_HELP } from "./commands.js";
import { logPrompt } from "./logger.js";

const PORT = 8767;

export class LocalVoiceSocketBridge {
    constructor({ settings = null, characterStore = null } = {}) {
        this.settings = settings || loadSettings();
        this.characterStore = characterStore || loadCharacterStore();
        this.server = null;
        this.activeWs = new Set();
    }

    async processVoiceQuery(ws, audioBase64, mimeType = null, chatId = "web_voice_session") {
        const activeChar = getActiveCharacter(this.characterStore);
        const session = loadSession(chatId, activeChar.id) || createSession(activeChar.id, "Voice Conversation");
        const sessionMessages = session.messages || [];

        const tmpAudioDir = path.join(process.cwd(), "tmp");
        if (!fs.existsSync(tmpAudioDir)) fs.mkdirSync(tmpAudioDir, { recursive: true });

        let ext = ".webm";
        if (mimeType) {
            if (mimeType.includes("mp4")) ext = ".mp4";
            else if (mimeType.includes("ogg")) ext = ".ogg";
            else if (mimeType.includes("wav")) ext = ".wav";
        }

        const audioFilePath = path.join(tmpAudioDir, `ws_voice_${Date.now()}${ext}`);
        const audioBuffer = Buffer.from(audioBase64, "base64");
        fs.writeFileSync(audioFilePath, audioBuffer);

        try {
            // 1. Local STT Transcription via Whisper
            ws.send(JSON.stringify({ event: "state_change", state: "transcribing" }));
            const sttRes = await transcribeAudioLocal(audioFilePath);
            const userText = (sttRes.text || "").trim();

            if (!userText) {
                ws.send(JSON.stringify({ event: "state_change", state: "idle" }));
                ws.send(JSON.stringify({ event: "llm_complete", text: "⚠️ Could not detect speech in audio." }));
                return;
            }

            // Show message on server terminal & log prompt
            console.log(`🌐 [Web View Voice]: "${userText}"`);
            logPrompt(userText, "web_voice");

            // Send transcribed text event
            ws.send(JSON.stringify({ event: "stt_transcript", text: userText }));

            const lowerVoice = userText.toLowerCase();
            if (lowerVoice === "/commands" || lowerVoice === "/help" || lowerVoice === "/get-commands") {
                ws.send(JSON.stringify({ event: "state_change", state: "idle" }));
                ws.send(JSON.stringify({ event: "llm_complete", text: COMMANDS_HELP }));
                return;
            }

            ws.send(JSON.stringify({ event: "state_change", state: "thinking" }));

            // 2. Assemble LLM prompt
            const modelMessages = [];
            const systemPromptText = composeSystemTemplate(activeChar);
            if (systemPromptText) {
                modelMessages.push({ role: "system", content: systemPromptText });
            }

            const relevantMemories = retrieveMemories(userText, 5);
            if (relevantMemories.length > 0) {
                modelMessages.push({
                    role: "system",
                    content: `[Relevant Persistent Memories]:\n${relevantMemories.map((m) => `• ${m}`).join("\n")}`,
                });
            }

            const historyWindow = sessionMessages.slice(-6);
            for (const h of historyWindow) {
                if (h.role === "user" || h.role === "assistant") {
                    modelMessages.push({ role: h.role, content: h.content });
                }
            }

            modelMessages.push({ role: "user", content: userText });

            // 3. Unified LLM Query
            const llmRes = await unifiedChat({
                modelName: activeChar.model || this.settings.model,
                messages: modelMessages,
                stream: false,
                settings: this.settings,
                ollamaClient: ollama,
            });

            const replyText = llmRes.content || "No response generated.";

            sessionMessages.push({ role: "user", content: userText });
            sessionMessages.push({ role: "assistant", content: replyText });
            saveSession(session.id, sessionMessages, activeChar.id);

            ws.send(JSON.stringify({ event: "llm_complete", text: replyText }));

            // 4. Local TTS Speech Synthesis via MMS-TTS
            try {
                ws.send(JSON.stringify({ event: "state_change", state: "speaking" }));
                const voiceWavPath = path.join(tmpAudioDir, `ws_reply_${Date.now()}.wav`);
                await synthesizeSpeechLocal(replyText, voiceWavPath);

                const wavBuffer = fs.readFileSync(voiceWavPath);
                if (fs.existsSync(voiceWavPath)) fs.unlinkSync(voiceWavPath);

                const base64Wav = wavBuffer.toString("base64");
                ws.send(JSON.stringify({ event: "tts_audio", audio: base64Wav, format: "wav" }));
            } catch (ttsErr) {
                console.error("⚠️ Local Voice Socket TTS Error:", ttsErr.message);
                ws.send(JSON.stringify({ event: "state_change", state: "idle" }));
            }

        } catch (err) {
            console.error("⚠️ Local Voice Socket processing error:", err);
            ws.send(JSON.stringify({ event: "state_change", state: "idle" }));
            ws.send(JSON.stringify({ event: "llm_complete", text: `⚠️ Voice Error: ${err.message}` }));
        } finally {
            if (fs.existsSync(audioFilePath)) {
                try {
                    fs.unlinkSync(audioFilePath);
                } catch (_) {}
            }
        }
    }

    async processTextQuery(ws, userText, chatId = "web_voice_session") {
        if (!userText || !userText.trim()) return;

        const trimmedText = userText.trim();
        console.log(`🌐 [Web View]: "${trimmedText}"`);
        logPrompt(trimmedText, "web");

        const activeChar = getActiveCharacter(this.characterStore);
        const session = loadSession(chatId, activeChar.id) || createSession(activeChar.id, "Voice Conversation");
        const sessionMessages = session.messages || [];

        ws.send(JSON.stringify({ event: "stt_transcript", text: trimmedText }));

        const lowerText = trimmedText.toLowerCase();
        if (lowerText === "/commands" || lowerText === "/help" || lowerText === "/get-commands") {
            ws.send(JSON.stringify({ event: "state_change", state: "idle" }));
            ws.send(JSON.stringify({ event: "llm_complete", text: COMMANDS_HELP }));
            return;
        }

        ws.send(JSON.stringify({ event: "state_change", state: "thinking" }));

        try {
            const modelMessages = [];
            const systemPromptText = composeSystemTemplate(activeChar);
            if (systemPromptText) {
                modelMessages.push({ role: "system", content: systemPromptText });
            }

            const relevantMemories = retrieveMemories(userText, 5);
            if (relevantMemories.length > 0) {
                modelMessages.push({
                    role: "system",
                    content: `[Relevant Persistent Memories]:\n${relevantMemories.map((m) => `• ${m}`).join("\n")}`,
                });
            }

            const historyWindow = sessionMessages.slice(-6);
            for (const h of historyWindow) {
                if (h.role === "user" || h.role === "assistant") {
                    modelMessages.push({ role: h.role, content: h.content });
                }
            }

            modelMessages.push({ role: "user", content: userText });

            const llmRes = await unifiedChat({
                modelName: activeChar.model || this.settings.model,
                messages: modelMessages,
                stream: false,
                settings: this.settings,
                ollamaClient: ollama,
            });

            const replyText = llmRes.content || "No response generated.";

            sessionMessages.push({ role: "user", content: userText });
            sessionMessages.push({ role: "assistant", content: replyText });
            saveSession(session.id, sessionMessages, activeChar.id);

            ws.send(JSON.stringify({ event: "llm_complete", text: replyText }));

            try {
                ws.send(JSON.stringify({ event: "state_change", state: "speaking" }));
                const tmpAudioDir = path.join(process.cwd(), "tmp");
                if (!fs.existsSync(tmpAudioDir)) fs.mkdirSync(tmpAudioDir, { recursive: true });

                const voiceWavPath = path.join(tmpAudioDir, `ws_reply_${Date.now()}.wav`);
                await synthesizeSpeechLocal(replyText, voiceWavPath);

                const wavBuffer = fs.readFileSync(voiceWavPath);
                if (fs.existsSync(voiceWavPath)) fs.unlinkSync(voiceWavPath);

                const base64Wav = wavBuffer.toString("base64");
                ws.send(JSON.stringify({ event: "tts_audio", audio: base64Wav, format: "wav" }));
            } catch (ttsErr) {
                console.error("⚠️ Local Voice Socket TTS Error:", ttsErr.message);
                ws.send(JSON.stringify({ event: "state_change", state: "idle" }));
            }
        } catch (err) {
            console.error("⚠️ Local Voice Socket text processing error:", err);
            ws.send(JSON.stringify({ event: "state_change", state: "idle" }));
            ws.send(JSON.stringify({ event: "llm_complete", text: `⚠️ Error: ${err.message}` }));
        }
    }

    start(port = PORT) {
        if (this.server) return;

        const htmlPath = path.join(process.cwd(), "voice_interface.html");

        try {
            this.server = Bun.serve({
                port,
                fetch: (req, server) => {
                    const url = new URL(req.url);
                    if (url.pathname === "/ws") {
                        if (server.upgrade(req)) return;
                        return new Response("Upgrade failed", { status: 400 });
                    }
                    if (fs.existsSync(htmlPath)) {
                        const html = fs.readFileSync(htmlPath, "utf8");
                        return new Response(html, { headers: { "Content-Type": "text/html" } });
                    }
                    return new Response("Dagowan Voice AI Interface HTML file missing.", { status: 444 });
                },
                websocket: {
                    open: (ws) => {
                        this.activeWs.add(ws);
                        console.log("🎙 WebSocket Voice Client connected to Dagowan Voice Socket Bridge.");
                        ws.send(
                            JSON.stringify({
                                event: "connected",
                                message: "Connected to Local Dagowan Voice AI Bridge",
                                settings: this.settings,
                            })
                        );
                    },
                    message: async (ws, message) => {
                        try {
                            const data = JSON.parse(message);
                            if (data.event === "audio_data" && data.audio) {
                                await this.processVoiceQuery(ws, data.audio, data.mimeType);
                            } else if (data.event === "text_prompt" && data.text) {
                                await this.processTextQuery(ws, data.text);
                            }
                        } catch (err) {
                            console.error("WebSocket message error:", err.message);
                        }
                    },
                    close: (ws) => {
                        this.activeWs.delete(ws);
                        console.log("🎙 WebSocket Voice Client disconnected.");
                    },
                },
            });

            console.log("=========================================================================");
            console.log(`🎙 Dagowan Voice AI WebSocket Server active on http://127.0.0.1:${port}`);
            console.log(`🎙 Web UI Available at: http://127.0.0.1:${port}`);
            console.log("=========================================================================");
        } catch (err) {
            if (err.code === "EADDRINUSE" || (err.message && err.message.includes("EADDRINUSE"))) {
                console.log(`🌐 Dagowan Voice Web Bridge listening on http://127.0.0.1:${port} (already active)`);
                return;
            }
            throw err;
        }
    }

    stop() {
        if (this.server) {
            this.server.stop();
            this.server = null;
            console.log("🎙 Dagowan Voice AI WebSocket Server stopped.");
        }
    }
}
