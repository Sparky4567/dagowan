import { logPrompt } from "./logger.js";
import fs from "node:fs";
import path from "node:path";
import ollama from "ollama";
import { unifiedChat } from "./providers.js";
import { loadMemories, remember, retrieveMemories } from "./memory.js";
import { transcribeAudioLocal, synthesizeSpeechLocal } from "./audio.js";
import {
    registerTask,
    formatActiveTasks,
    moveTask,
    deleteTask,
    parseMoveTaskCommand,
    parseDeleteTaskCommand,
} from "./tasks.js";
import {
    getActiveCharacter,
    composeSystemTemplate,
    getAllCharacterTelegramBots,
} from "./characters.js";
import { remoteSession, saveSession } from "./sessions.js";
import { retrieveNotesChunks, writeAboutPrompt } from "./workspace.js";
import { convertNotesToPdf, convertPdfToMd } from "./pdf_utils.js";
import { exportSettings, importSettings } from "./config.js";
import { AgenticModule } from "./agentic.js";
import { COMMANDS_HELP } from "./commands.js";
import { handleProactiveCommand } from "./proactive.js";

function splitTelegramMessage(text, maxLength = 4000) {
    if (!text) return [];
    if (text.length <= maxLength) return [text];

    const parts = [];
    let current = "";
    const lines = text.split("\n");

    for (const line of lines) {
        if ((current + "\n" + line).length > maxLength) {
            if (current) parts.push(current);
            current = line;
        } else {
            current = current ? current + "\n" + line : line;
        }
    }
    if (current) parts.push(current);
    return parts;
}

export class TelegramBotRunner {
    constructor({ characterProfile, token, settings, proactiveManager = null }) {
        this.characterProfile = characterProfile;
        this.token = token;
        this.settings = settings;
        this.proactiveManager = proactiveManager;
        this.baseUrl = `https://api.telegram.org/bot${token}`;
        this.running = false;
        this.offset = 0;
        this.lastUpdateId = 0;
        this.agentic = new AgenticModule();
        this.lastChatId = null;
    }

    async apiCall(method, params = {}) {
        const url = `${this.baseUrl}/${method}`;
        try {
            const res = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(params),
            });
            return await res.json();
        } catch (err) {
            return { ok: false, error: err.message };
        }
    }

    async sendMessage(chatId, text) {
        const chunks = splitTelegramMessage(text);
        for (const chunk of chunks) {
            await this.apiCall("sendMessage", {
                chat_id: chatId,
                text: chunk,
            });
        }
    }

    async sendVoice(chatId, voiceFilePath, caption = "") {
        try {
            const url = `${this.baseUrl}/sendVoice`;
            const formData = new FormData();
            formData.append("chat_id", String(chatId));
            if (caption) formData.append("caption", caption.slice(0, 1000));

            const fileBuf = fs.readFileSync(voiceFilePath);
            const blob = new Blob([fileBuf], { type: "audio/ogg" });
            formData.append("voice", blob, path.basename(voiceFilePath));

            const res = await fetch(url, { method: "POST", body: formData });
            return await res.json();
        } catch (err) {
            console.error("⚠️ Failed to send Telegram voice note:", err.message);
            return { ok: false, error: err.message };
        }
    }

    async downloadFile(fileId, savePath) {
        const fileRes = await this.apiCall("getFile", { file_id: fileId });
        if (!fileRes.ok || !fileRes.result?.file_path) {
            throw new Error(`Failed to get Telegram file metadata for ${fileId}`);
        }
        const downloadUrl = `https://api.telegram.org/file/bot${this.token}/${fileRes.result.file_path}`;
        const res = await fetch(downloadUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status} downloading file from Telegram`);
        const arrayBuf = await res.arrayBuffer();
        const dir = path.dirname(savePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(savePath, Buffer.from(arrayBuf));
        return savePath;
    }

    async handleUpdate(update) {
        if (!update.message) return;

        const chatId = update.message.chat.id;
        this.lastChatId = chatId;
        const activeChar = this.characterProfile;

        let msgText = (update.message.text || update.message.caption || "").trim();
        let isVoiceInput = false;

        // Voice or audio attachment detection
        const voiceObj = update.message.voice || update.message.audio || (update.message.document && update.message.document.mime_type?.startsWith("audio") ? update.message.document : null);
        if (voiceObj && voiceObj.file_id) {
            isVoiceInput = true;
            try {
                await this.sendMessage(chatId, "🎙 Transcribing local voice message...");
                const tmpVoicePath = path.join(process.cwd(), "tmp", `tg_voice_${chatId}_${Date.now()}.ogg`);
                await this.downloadFile(voiceObj.file_id, tmpVoicePath);
                const sttRes = await transcribeAudioLocal(tmpVoicePath, { language: "english" });
                if (fs.existsSync(tmpVoicePath)) fs.unlinkSync(tmpVoicePath);

                if (sttRes.text) {
                    msgText = sttRes.text;
                    await this.sendMessage(chatId, `🗣 [Voice Transcribed]: "${msgText}"`);
                } else {
                    await this.sendMessage(chatId, "⚠️ Could not transcribe voice audio.");
                    return;
                }
            } catch (err) {
                await this.sendMessage(chatId, `⚠️ Voice processing error: ${err.message}`);
                return;
            }
        }

        if (!msgText) return;

        logPrompt(msgText, "telegram");

        if (this.proactiveManager) {
            this.proactiveManager.recordActivity(`tg_${chatId}`);
        }

        const lower = msgText.toLowerCase();

        // Proactive Chat Commands
        const proactiveRes = handleProactiveCommand(msgText, this.settings, this.proactiveManager);
        if (proactiveRes.handled) {
            await this.sendMessage(chatId, proactiveRes.output);
            return;
        }

        // 1. Slash commands & help
        if (lower === "/help" || lower === "/commands" || lower === "/get-commands") {
            await this.sendMessage(chatId, COMMANDS_HELP);
            return;
        }

        if (lower.startsWith("/voice-reply") || lower === "/voicereply" || lower.startsWith("/voice-mode") || lower === "/voicemode") {
            const parts = msgText.split(/\s+/);
            const arg = (parts[1] || "").toLowerCase();
            if (arg === "on" || arg === "true" || arg === "1") {
                this.settings.voice_reply_enabled = true;
            } else if (arg === "off" || arg === "false" || arg === "0") {
                this.settings.voice_reply_enabled = false;
            } else {
                this.settings.voice_reply_enabled = !this.settings.voice_reply_enabled;
            }
            await this.sendMessage(chatId, `🔊 Automatic Local Voice Reply / Voice Mode is now: ${this.settings.voice_reply_enabled ? "ENABLED (ON)" : "DISABLED (OFF)"}`);
            return;
        }

        // PDF conversion
        if (lower.startsWith("/convert-pdf") || lower.startsWith("/pdf")) {
            const parts = msgText.split(/\s+/);
            const fromD = parts[1] || "";
            const toD = parts[2] || "";
            const res = convertNotesToPdf("notes", "pdfs", fromD, toD);
            await this.sendMessage(chatId, res.success ? `📄 ${res.output}` : `⚠️ ${res.error}`);
            return;
        }

        if (lower.startsWith("/pdf-to-md") || lower.startsWith("/convert-md")) {
            const parts = msgText.split(/\s+/);
            const pdfFile = parts[1] || "";
            if (!pdfFile) {
                await this.sendMessage(chatId, "⚠️ Usage: /pdf-to-md <filename.pdf>");
                return;
            }
            const res = convertPdfToMd(pdfFile, "notes");
            await this.sendMessage(chatId, res.success ? `📄 ${res.output}` : `⚠️ ${res.error}`);
            return;
        }

        // Backup / Restore
        if (lower.startsWith("/export-settings") || lower.startsWith("/backup")) {
            const backupPath = exportSettings();
            await this.sendMessage(chatId, `💾 Backup created: ${backupPath}`);
            return;
        }

        if (lower.startsWith("/import-settings") || lower.startsWith("/restore")) {
            const parts = msgText.split(/\s+/);
            const file = parts[1] || "";
            const res = importSettings(file);
            await this.sendMessage(chatId, res.success ? `✅ ${res.message}` : `⚠️ ${res.message}`);
            return;
        }

        // Memory
        if (lower.startsWith("/remember ")) {
            const text = msgText.slice(10).trim();
            remember(text);
            const session = remoteSession("telegram", String(chatId), activeChar.id);
            if (session && Array.isArray(session.messages)) {
                session.messages.push({
                    role: "system",
                    content: `[Persistent Memory Added]: "${text}"`,
                });
                saveSession(session.id, session.messages);
            }
            await this.sendMessage(chatId, `🧠 Memory saved & context refreshed: "${text}"`);
            return;
        }

        // Tasks
        if (lower.startsWith("/register-task ")) {
            const text = msgText.slice(15).trim();
            const task = registerTask(text, "p");
            await this.sendMessage(chatId, `📋 Task "#${task.id}" registered into Processing (p) status.`);
            return;
        }

        if (lower === "/get-tasks" || lower === "/tasks") {
            await this.sendMessage(chatId, formatActiveTasks());
            return;
        }

        const moveInfo = parseMoveTaskCommand(msgText);
        if (moveInfo) {
            const res = moveTask(moveInfo.taskId, moveInfo.status);
            await this.sendMessage(
                chatId,
                res.success ? `📋 Task #${res.task.id} moved to ${res.task.status}.` : `⚠️ ${res.message}`
            );
            return;
        }

        const delTaskId = parseDeleteTaskCommand(msgText);
        if (delTaskId !== null) {
            const res = deleteTask(delTaskId);
            await this.sendMessage(chatId, res.success ? `🗑 Task #${res.task.id} deleted.` : `⚠️ ${res.message}`);
            return;
        }

        // Agentic Web tools
        const agenticRes = this.agentic.selectTool(msgText);
        if (agenticRes.handled) {
            await this.sendMessage(chatId, agenticRes.message);
            return;
        }

        // 2. Chat with Ollama + Context injection
        let queryText = msgText;
        if (lower.startsWith("/fetch-note-about ") || lower.startsWith("/write-about ")) {
            const topic = lower.startsWith("/fetch-note-about ") ? msgText.slice(18).trim() : msgText.slice(13).trim();
            const { prompt } = writeAboutPrompt(topic);
            if (prompt) {
                queryText = prompt;
            } else {
                await this.sendMessage(chatId, `⚠️ No notes found matching topic "${topic}".`);
                return;
            }
        }

        // Store session for telegram chat_id & persona profile
        const session = remoteSession("telegram", String(chatId), activeChar.id);
        const sessionMessages = session.messages || [];

        const modelMessages = [];

        // System prompt from persona profile
        const systemPromptText = composeSystemTemplate(activeChar);
        if (systemPromptText) {
            modelMessages.push({ role: "system", content: systemPromptText });
        }

        // Relevant memories
        const memories = retrieveMemories(queryText, 5);
        if (memories.length > 0) {
            modelMessages.push({
                role: "system",
                content: `[Relevant Persistent Memories]:\n${memories.map((m) => `• ${m}`).join("\n")}`,
            });
        }

        // Relevant note chunks
        const chunks = retrieveNotesChunks(queryText, "notes", 5);
        if (chunks.length > 0) {
            const chunkBlock = chunks.map((c) => `[${c.filename}]\n${c.text}`).join("\n\n");
            modelMessages.push({
                role: "system",
                content: `[Relevant Workspace Notes Excerpts]:\n${chunkBlock}`,
            });
        }

        // Add recent session history
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
            await this.sendMessage(chatId, reply);

            // Save conversation back to session
            sessionMessages.push({ role: "user", content: msgText });
            sessionMessages.push({ role: "assistant", content: reply });
            saveSession(session.id, sessionMessages, activeChar.id);

            // Synthesize and send local voice note response if voice_reply is enabled
            if (this.settings.voice_reply_enabled) {
                try {
                    const voiceReplyPath = path.join(process.cwd(), "tmp", `tg_reply_${chatId}_${Date.now()}.ogg`);
                    await synthesizeSpeechLocal(reply, voiceReplyPath);
                    await this.sendVoice(chatId, voiceReplyPath);
                    if (fs.existsSync(voiceReplyPath)) fs.unlinkSync(voiceReplyPath);
                } catch (vErr) {
                    console.error("⚠️ Failed to generate voice note reply:", vErr.message);
                }
            }
        } catch (err) {
            await this.sendMessage(chatId, `⚠️ LLM Error: ${err.message}`);
        }
    }

    async start() {
        if (!this.token) {
            return false;
        }

        const me = await this.apiCall("getMe");
        if (!me.ok) {
            console.log(`⚠️ Telegram Bot connection failed for persona "${this.characterProfile.name}": ${me.description || me.error}`);
            return false;
        }

        console.log(`✈️ Telegram Bot active for persona "${this.characterProfile.name}" (@${me.result.username})`);
        this.running = true;

        // Long polling loop
        (async () => {
            while (this.running) {
                try {
                    const res = await this.apiCall("getUpdates", {
                        offset: this.lastUpdateId ? this.lastUpdateId + 1 : 0,
                        timeout: 20,
                    });

                    if (res.ok && Array.isArray(res.result)) {
                        for (const update of res.result) {
                            this.lastUpdateId = update.update_id;
                            await this.handleUpdate(update);
                        }
                    }
                } catch (err) {
                    await new Promise((r) => setTimeout(r, 3000));
                }
            }
        })();

        return true;
    }

    stop() {
        this.running = false;
    }
}

/**
 * Starts Telegram bot instances for all persona profiles defined in characters.json
 * that have a telegram_token (or global fallback token in app_settings.json).
 */
export async function startAllTelegramBots({ characterStore, settings, fallbackToken = "", proactiveManager = null }) {
    const botsConfig = getAllCharacterTelegramBots(characterStore, fallbackToken || settings.telegram_token || process.env.TELEGRAM_TOKEN);
    const activeRunners = [];

    if (botsConfig.length === 0) {
        console.log("✈️ Telegram Bridge: Disabled/Inactive (No bot tokens configured. Use /set-telegram-token <token> or TELEGRAM_TOKEN env var).");
        return activeRunners;
    }

    for (const cfg of botsConfig) {
        const runner = new TelegramBotRunner({
            token: cfg.token,
            characterProfile: cfg.character,
            characterStore,
            settings,
            proactiveManager,
        });
        const ok = await runner.start();
        if (ok) {
            activeRunners.push(runner);
        }
    }

    return activeRunners;
}
