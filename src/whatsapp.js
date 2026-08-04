import { logPrompt } from "./logger.js";
import http from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import ollama from "ollama";
import { unifiedChat } from "./providers.js";
import { transcribeAudioLocal, synthesizeSpeechLocal } from "./audio.js";

import { loadMemories, remember, retrieveMemories } from "./memory.js";
import {
    registerTask,
    formatActiveTasks,
    moveTask,
    deleteTask,
    parseMoveTaskCommand,
    parseDeleteTaskCommand,
} from "./tasks.js";
import { getActiveCharacter, composeSystemTemplate } from "./characters.js";
import { remoteSession, saveSession } from "./sessions.js";
import { retrieveNotesChunks, writeAboutPrompt } from "./workspace.js";
import { convertNotesToPdf, convertPdfToMd } from "./pdf_utils.js";
import { exportSettings, importSettings } from "./config.js";
import { AgenticModule } from "./agentic.js";
import { COMMANDS_HELP } from "./commands.js";
import { handleProactiveCommand } from "./proactive.js";

const DEFAULT_PORT = 8765;
const DEFAULT_STATUS_PORT = 8766;

export function resetWhatsAppAuth() {
    const authDir = path.join(process.cwd(), "whatsapp_bridge", "auth");
    if (fs.existsSync(authDir)) {
        const files = fs.readdirSync(authDir);
        for (const file of files) {
            try {
                fs.unlinkSync(path.join(authDir, file));
            } catch {}
        }
        return { success: true, message: "Cleared stale WhatsApp authentication keys. Re-scan QR code to reconnect." };
    }
    return { success: false, message: "whatsapp_bridge/auth directory not found." };
}

export async function requestWhatsAppPairing(phone) {
    try {
        const res = await fetch("http://127.0.0.1:8766/pair", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ phone }),
        });
        const data = await res.json();
        if (data.ok && data.pairingCode) {
            return { success: true, pairingCode: data.pairingCode };
        } else {
            return { success: false, error: data.error || "Failed to request pairing code" };
        }
    } catch (err) {
        return { success: false, error: err.message };
    }
}

export class WhatsAppNodeBridgeProcess {
    constructor(settings = null) {
        this.settings = settings;
        this.process = null;
    }

    start() {
        if (this.process) return;

        const bridgeDir = path.join(process.cwd(), "whatsapp_bridge");
        const entrypoint = path.join(bridgeDir, "index.js");

        if (!fs.existsSync(entrypoint)) {
            console.error("⚠️ whatsapp_bridge/index.js missing.");
            return;
        }

        const phone = (this.settings && this.settings.whatsapp_phone) || process.env.WHATSAPP_PHONE || "";

        try {
            this.process = spawn("node", [entrypoint], {
                cwd: bridgeDir,
                env: {
                    ...process.env,
                    JARVIS_CHAT_URL: `http://127.0.0.1:${DEFAULT_PORT}/chat`,
                    WHATSAPP_STATUS_PORT: String(DEFAULT_STATUS_PORT),
                    WHATSAPP_PHONE: phone,
                },
                stdio: "inherit",
            });

            console.log("📱 WhatsApp Node Baileys bridge socket process started.");
            if (phone) {
                console.log(`📱 Default WhatsApp Phone number set: +${phone.replace(/[^0-9]/g, "")}`);
            }
            console.log("=========================================================================");
            console.log("📱 QR Code / Pairing Web View: http://127.0.0.1:8766/qr");
            console.log(`📁 Local HTML file: file://${path.join(process.cwd(), "whatsapp_qr.html")}`);
            console.log("=========================================================================");

            this.process.on("error", (err) => {
                console.error("📱 WhatsApp node bridge process error:", err.message);
            });

            this.process.on("exit", (code) => {
                this.process = null;
                if (code !== 0 && code !== null) {
                    console.log(`📱 WhatsApp node bridge process exited with code ${code}.`);
                }
            });
        } catch (err) {
            console.error("📱 Failed to launch WhatsApp node bridge:", err.message);
        }
    }

    stop() {
        if (this.process) {
            try {
                this.process.kill("SIGTERM");
            } catch {}
            this.process = null;
            console.log("📱 WhatsApp node bridge process stopped.");
        }
    }
}

export class WhatsAppBridgeServer {
    constructor({ port = DEFAULT_PORT, statusPort = DEFAULT_STATUS_PORT, characterStore, settings, proactiveManager = null }) {
        this.port = port;
        this.statusPort = statusPort;
        this.characterStore = characterStore;
        this.settings = settings;
        this.proactiveManager = proactiveManager;
        this.server = null;
        this.nodeProcess = new WhatsAppNodeBridgeProcess(settings);
        this.agentic = new AgenticModule();
    }

    async processPrompt(promptText, chatId) {
        if (!promptText || !promptText.trim()) {
            return "No input provided.";
        }

        logPrompt(promptText, "whatsapp");

        if (this.proactiveManager) {
            this.proactiveManager.recordActivity(`wa_${chatId}`);
        }

        const activeChar = getActiveCharacter(this.characterStore);
        const lower = promptText.trim().toLowerCase();

        // Proactive Chat Commands
        const proactiveRes = handleProactiveCommand(promptText, this.settings, this.proactiveManager);
        if (proactiveRes.handled) {
            return proactiveRes.output;
        }

        // Commands handling
        if (lower === "/help" || lower === "/commands" || lower === "/get-commands") {
            return COMMANDS_HELP;
        }

        if (lower.startsWith("/voice-reply") || lower === "/voicereply" || lower.startsWith("/voice-mode") || lower === "/voicemode") {
            const parts = promptText.split(/\s+/);
            const arg = (parts[1] || "").toLowerCase();
            if (arg === "on" || arg === "true" || arg === "1") {
                this.settings.voice_reply_enabled = true;
            } else if (arg === "off" || arg === "false" || arg === "0") {
                this.settings.voice_reply_enabled = false;
            } else {
                this.settings.voice_reply_enabled = !this.settings.voice_reply_enabled;
            }
            return `🔊 Automatic Local Voice Reply / Voice Mode is now: ${this.settings.voice_reply_enabled ? "ENABLED (ON)" : "DISABLED (OFF)"}`;
        }

        if (lower.startsWith("/convert-pdf") || lower.startsWith("/pdf")) {
            const parts = promptText.split(/\s+/);
            const res = convertNotesToPdf("notes", "pdfs", parts[1] || "", parts[2] || "");
            return res.success ? `📄 ${res.output}` : `⚠️ ${res.error}`;
        }

        if (lower.startsWith("/pdf-to-md") || lower.startsWith("/convert-md")) {
            const parts = promptText.split(/\s+/);
            const pdfFile = parts[1] || "";
            if (!pdfFile) return "⚠️ Usage: /pdf-to-md <filename.pdf>";
            const res = convertPdfToMd(pdfFile, "notes");
            return res.success ? `📄 ${res.output}` : `⚠️ ${res.error}`;
        }

        if (lower.startsWith("/export-settings") || lower.startsWith("/backup")) {
            const backupPath = exportSettings();
            return `💾 Backup created: ${backupPath}`;
        }

        if (lower.startsWith("/import-settings") || lower.startsWith("/restore")) {
            const parts = promptText.split(/\s+/);
            const res = importSettings(parts[1] || "");
            return res.success ? `✅ ${res.message}` : `⚠️ ${res.message}`;
        }

        if (lower.startsWith("/remember ")) {
            const text = promptText.slice(10).trim();
            remember(text);
            const session = remoteSession("whatsapp", "default", activeChar.id);
            if (session && Array.isArray(session.messages)) {
                session.messages.push({
                    role: "system",
                    content: `[Persistent Memory Added]: "${text}"`,
                });
                saveSession(session.id, session.messages);
            }
            return `🧠 Memory saved & context refreshed: "${text}"`;
        }

        if (lower.startsWith("/register-task ")) {
            const text = promptText.slice(15).trim();
            const task = registerTask(text, "p");
            return `📋 Task "#${task.id}" registered into Processing (p) status.`;
        }

        if (lower === "/get-tasks" || lower === "/tasks") {
            return formatActiveTasks();
        }

        const moveInfo = parseMoveTaskCommand(promptText);
        if (moveInfo) {
            const res = moveTask(moveInfo.taskId, moveInfo.status);
            return res.success ? `📋 Task #${res.task.id} moved to ${res.task.status}.` : `⚠️ ${res.message}`;
        }

        const delTaskId = parseDeleteTaskCommand(promptText);
        if (delTaskId !== null) {
            const res = deleteTask(delTaskId);
            return res.success ? `🗑 Task #${res.task.id} deleted.` : `⚠️ ${res.message}`;
        }

        const agenticRes = this.agentic.selectTool(promptText);
        if (agenticRes.handled) {
            return agenticRes.message;
        }

        // Ollama query
        let queryText = promptText;
        if (lower.startsWith("/fetch-note-about ") || lower.startsWith("/write-about ")) {
            const topic = lower.startsWith("/fetch-note-about ") ? promptText.slice(18).trim() : promptText.slice(13).trim();
            const { prompt } = writeAboutPrompt(topic);
            if (prompt) {
                queryText = prompt;
            } else {
                return `⚠️ No notes found matching topic "${topic}".`;
            }
        }

        const session = remoteSession("whatsapp", String(chatId), activeChar.id);
        const sessionMessages = session.messages || [];

        const modelMessages = [];
        const systemPromptText = composeSystemTemplate(activeChar);
        if (systemPromptText) {
            modelMessages.push({ role: "system", content: systemPromptText });
        }

        const memories = retrieveMemories(queryText, 5);
        if (memories.length > 0) {
            modelMessages.push({
                role: "system",
                content: `[Relevant Persistent Memories]:\n${memories.map((m) => `• ${m}`).join("\n")}`,
            });
        }

        const chunks = retrieveNotesChunks(queryText, "notes", 5);
        if (chunks.length > 0) {
            const chunkBlock = chunks.map((c) => `[${c.filename}]\n${c.text}`).join("\n\n");
            modelMessages.push({
                role: "system",
                content: `[Relevant Workspace Notes Excerpts]:\n${chunkBlock}`,
            });
        }

        const recentHistory = sessionMessages.slice(-6);
        for (const h of recentHistory) {
            if (h.role === "user" || h.role === "assistant") {
                modelMessages.push({ role: h.role, content: h.content });
            }
        }

        modelMessages.push({ role: "user", content: queryText });

        try {
            const response = await unifiedChat({
                modelName: activeChar.model || this.settings.model,
                messages: modelMessages,
                stream: false,
                settings: this.settings,
                ollamaClient: ollama,
            });

            const reply = response.content || "No response received.";
            sessionMessages.push({ role: "user", content: promptText });
            sessionMessages.push({ role: "assistant", content: reply });
            saveSession(session.id, sessionMessages, activeChar.id);

            return reply;
        } catch (err) {
            return `⚠️ LLM Error: ${err.message}`;
        }
    }

    start() {
        if (this.server) return;

        this.server = http.createServer(async (req, res) => {
            if (req.method === "GET" && req.url === "/health") {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: true, status: "running" }));
                return;
            }

            if (req.method === "POST" && req.url === "/chat") {
                let body = "";
                req.on("data", (chunk) => (body += chunk));
                req.on("end", async () => {
                    try {
                        const payload = JSON.parse(body);
                        let text = String(payload.text || "").trim();
                        const chatId = String(payload.chat_id || "unknown");
                        const audioFile = payload.audio_file || null;
                        let isVoiceInput = false;

                        if (audioFile && fs.existsSync(audioFile)) {
                            isVoiceInput = true;
                            console.log(`🎙️ [WhatsApp Audio Received] Transcribing audio from ${chatId}...`);
                            try {
                                const sttRes = await transcribeAudioLocal(audioFile, { language: "english" });
                                if (sttRes.text) {
                                    text = sttRes.text;
                                    console.log(`🗣️ [WhatsApp Voice Transcribed] (${chatId}): "${text}"`);
                                } else if (!text) {
                                    text = "[Voice/audio message received but speech could not be transcribed or was silent]";
                                    console.log(`⚠️ [WhatsApp Voice Transcribed] (${chatId}): ${text}`);
                                }
                            } catch (sttErr) {
                                console.error("⚠️ WhatsApp local STT error:", sttErr.message);
                                if (!text) {
                                    text = `[Voice/audio attachment received but transcription failed: ${sttErr.message}]`;
                                }
                            } finally {
                                try { fs.unlinkSync(audioFile); } catch {}
                            }
                        }

                        if (!text) {
                            res.writeHead(400, { "Content-Type": "application/json" });
                            res.end(JSON.stringify({ ok: false, error: "text or audio_file is required" }));
                            return;
                        }

                        const reply = await this.processPrompt(text, chatId);

                        let voiceReplyPath = null;
                        if (this.settings.voice_reply_enabled) {
                            try {
                                const outPath = path.join(process.cwd(), "tmp", `wa_reply_${Date.now()}.ogg`);
                                await synthesizeSpeechLocal(reply, outPath);
                                voiceReplyPath = outPath;
                            } catch (vErr) {
                                console.error("⚠️ WhatsApp local TTS error:", vErr.message);
                            }
                        }

                        res.writeHead(200, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ ok: true, reply, voice_reply: voiceReplyPath, transcribed_text: text, is_voice_input: isVoiceInput }));
                    } catch (err) {
                        res.writeHead(500, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ ok: false, error: err.message }));
                    }
                });
                return;
            }

            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "Not found" }));
        });

        this.server.on("error", (err) => {
            if (err.code === "EADDRINUSE") {
                console.log(`📱 WhatsApp HTTP Bridge listening on http://127.0.0.1:${this.port}/chat (already running)`);
                return;
            }
            console.error(`⚠️ WhatsApp HTTP Server Error: ${err.message}`);
        });

        this.server.listen(this.port, "127.0.0.1", () => {
            console.log(`📱 WhatsApp HTTP Bridge Server listening on http://127.0.0.1:${this.port}/chat`);
        });

        // Launch Node Baileys socket process
        this.nodeProcess.start();
    }

    stop() {
        if (this.nodeProcess) {
            this.nodeProcess.stop();
        }

        if (this.server) {
            this.server.close();
            this.server = null;
            console.log("📱 WhatsApp HTTP Bridge Server stopped.");
        }
    }
}
