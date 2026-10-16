import { logPrompt } from "./logger.js";
import fs from "node:fs";
import path from "node:path";
import ollama from "ollama";
import { unifiedChat } from "./providers.js";
import { loadMemories, remember, retrieveMemories } from "./memory.js";
import { retrieveKnowledge } from "./knowledge.js";
import { getLearningPipeline } from "./learning.js";
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
import { exportSettings, importSettings, saveSettings } from "./config.js";
import { AgenticModule } from "./agentic.js";
import { tryNeedleFastPath } from "./needle.js";
import { buildCommandsHelp } from "./commands.js";
import {
    addSimulationMemory,
    appendSimulationExchange,
    extractSimulationHeuristic,
    formatSimulationMemories,
    getActiveSimulation,
    getSimulationChatAugmentation,
    handleSimulationBridgeCommand,
    scopeKeyFor,
    searchSimulationArchives,
    formatSimulationArchiveBlock,
} from "./simulation.js";
import {
    browserClose,
    browserOpen,
    browserRead,
    browserScreenshot,
    browserSearchSpotify,
    browserSearchYoutube,
    browserStatus,
    formatBlogDraftResult,
    formatPlayResult,
    formatSpotifyPlayResult,
    parseBlogInput,
    parsePlayInput,
    parseSpotifyPlayInput,
} from "./browser.js";
import { playSpotify as playSpotifyViaApi, playYoutube as playYoutubeViaApi, getPlayStatus } from "./play_api.js";
import { detectBlogIntent, draftBlog as draftBlogViaApi } from "./blog_api.js";
import { checkFactClaim as checkFactClaimViaApi, formatFactCheckResult, parseFactCheckInput } from "./factcheck_api.js";
import { handleProactiveCommand } from "./proactive.js";
import { runMakeCommand, runCreateFileCommand } from "./ollama_coding.js";
import { runOpenCliCommand, checkOpenCliAccess } from "./opencli.js";
import {
    isOtpCommand,
    isProbablyControlCommand,
    isSurfaceLocked,
    lockedMessage,
    runOtpCommand,
    runSecurityCommand,
    telegramScope,
} from "./security.js";
import { runOpencodeCommand, checkOpencodeAccess, getEffectiveOpencodeModel, requireExplicitProjectPath, truncateForChat as truncateOpencodeForChat, runOpencodeSetupStep, formatOpencodeStart, formatOpencodeFinish } from "./opencode.js";
import { parseCastInput, runCastCommand } from "./cast/caster.js";

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
    constructor({ characterProfile, token, settings, proactiveManager = null, onActivity = null, characterStore = null }) {
        this.characterProfile = characterProfile;
        this.token = token;
        this.settings = settings;
        this.proactiveManager = proactiveManager;
        this.characterStore = characterStore;
        this.onActivity = typeof onActivity === "function" ? onActivity : null;
        this.personaBridge = null;
        this.baseUrl = `https://api.telegram.org/bot${token}`;
        this.running = false;
        this.offset = 0;
        this.lastUpdateId = 0;
        this.agentic = new AgenticModule();
        this.lastChatId = null;
        this.lastActivityAt = Date.now();
    }

    get characterId() {
        return this.characterProfile?.id || null;
    }

    setActivityHook(fn) {
        if (typeof fn === "function") this.onActivity = fn;
    }

    touch() {
        this.lastActivityAt = Date.now();
    }

    notifyActivity() {
        this.touch();
        try {
            if (this.onActivity && this.characterId) this.onActivity(this.characterId);
        } catch {}
    }

    async apiCall(method, params = {}, opts = {}) {
        const url = `${this.baseUrl}/${method}`;
        try {
            const res = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(params),
                ...(opts.signal ? { signal: opts.signal } : {}),
            });
            return await res.json();
        } catch (err) {
            // AbortError is expected on stop(); surface it so the poll loop can exit quietly.
            if (err && (err.name === "AbortError" || /abort/i.test(err.message || ""))) {
                return { ok: false, aborted: true, error: err.message };
            }
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
        this.notifyActivity();
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

        // Canonical "@" commands (MCP-style); "/" still accepted via normalized copy.
        // "@" and "/" are both 1 char so all slice offsets below work for either prefix.
        const cmdText = msgText.startsWith("@") ? "/" + msgText.slice(1) : msgText;
        const lower = cmdText.toLowerCase();

        // Security PIN + OTP: @set-security-pin / @unlock / @lock /
        // @security-status / @remove-security-pin and @otp-set / @otp-login /
        // @otp-lock / @otp-remove / @otp-status work while locked;
        // every other control-shaped message needs @otp-login (+ @unlock when
        // a PIN is set) first. Regular chatting always passes through.
        const tgScope = telegramScope(chatId);
        const tgSec = runSecurityCommand(msgText, this.settings, tgScope);
        if (tgSec.handled) {
            if (tgSec.settingsChanged) {
                try { saveSettings(this.settings); } catch {}
            }
            await this.sendMessage(chatId, tgSec.reply);
            return;
        }
        const tgOtp = runOtpCommand(msgText, this.settings, tgScope);
        if (tgOtp.handled) {
            if (tgOtp.settingsChanged) {
                try { saveSettings(this.settings); } catch {}
            }
            await this.sendMessage(chatId, tgOtp.reply);
            return;
        }
        const tgLocked = isSurfaceLocked(this.settings, tgScope);
        if (tgLocked && !isOtpCommand(lower)) {
            const tgChars = (this.characterStore && this.characterStore.characters) || [];
            if (isProbablyControlCommand(msgText, tgChars) || detectBlogIntent(msgText)) {
                await this.sendMessage(chatId, lockedMessage(this.settings, tgScope));
                return;
            }
        }

        // Proactive Chat Commands
        const proactiveRes = handleProactiveCommand(msgText, this.settings, this.proactiveManager);
        if (proactiveRes.handled) {
            await this.sendMessage(chatId, proactiveRes.output);
            return;
        }

        // Simulation mode: simple separate chat thread, same persona.
        {
            const simCmd = handleSimulationBridgeCommand(msgText, {
                platform: "telegram",
                characterId: activeChar.id,
                personaName: activeChar.name,
                chatId: String(chatId),
            });
            if (simCmd.handled) {
                await this.sendMessage(chatId, simCmd.reply);
                return;
            }
        }

        // Daily self-reflections (@insight family; lock-gated above).
        {
            try {
                const { parseAutoInsightCommand, handleAutoInsightCommand } = await import("./auto_insight.js");
                if (parseAutoInsightCommand(msgText)) {
                    const res = await handleAutoInsightCommand(msgText, {
                        settings: this.settings,
                        persist: (s) => { try { saveSettings(s); } catch {} },
                    });
                    if (res.handled) {
                        await this.sendMessage(chatId, res.reply);
                        return;
                    }
                }
                const { parseInsightCommand, handleReflectionBridgeCommand } = await import("./reflections.js");
                if (parseInsightCommand(msgText)) {
                    const { Ollama } = await import("ollama");
                    let tgOllama = null;
                    try { tgOllama = new Ollama({ host: this.settings.server_url }); } catch {}
                    const res = await handleReflectionBridgeCommand(msgText, {
                        characterId: activeChar.id,
                        personaName: activeChar.name,
                        settings: this.settings,
                        ollamaClient: tgOllama,
                    });
                    if (res.handled) {
                        await this.sendMessage(chatId, res.reply);
                        return;
                    }
                }
            } catch {}
        }

        // Persona polling bridge commands (on-demand Telegram polling)
        if (lower === "/polling-status" || lower === "/polling" || lower === "/pollers") {
            const bridge = this.personaBridge;
            await this.sendMessage(chatId, bridge && typeof bridge.formatStatus === "function" ? bridge.formatStatus() : "🔌 Persona polling bridge not initialized.");
            return;
        }
        if (lower === "/wake" || lower.startsWith("/wake ")) {
            const target = msgText.slice(5).trim();
            const bridge = this.personaBridge;
            if (!target) {
                await this.sendMessage(chatId, "⚠️ Usage: @wake <character name|id>");
                return;
            }
            if (!bridge || typeof bridge.ensurePersona !== "function") {
                await this.sendMessage(chatId, "⚠️ Persona polling bridge not initialized.");
                return;
            }
            const res = await bridge.ensurePersona(target, "telegram-wake");
            await this.sendMessage(chatId, res && res.runner ? (res.started ? `🔌 Polling started for "${res.character?.name || target}".` : `🔌 "${res.character?.name || target}" is already polling.`) : `⚠️ Cannot wake "${target}": ${res?.reason || "no Telegram token"}.`);
            return;
        }
        if (lower === "/sleep" || lower.startsWith("/sleep ")) {
            const target = msgText.slice(6).trim();
            const bridge = this.personaBridge;
            if (!target) {
                await this.sendMessage(chatId, "⚠️ Usage: @sleep <character name|id>");
                return;
            }
            if (!bridge || typeof bridge.sleepPersona !== "function") {
                await this.sendMessage(chatId, "⚠️ Persona polling bridge not initialized.");
                return;
            }
            const res = await bridge.sleepPersona(target);
            await this.sendMessage(chatId, res.success ? `🔌 ${res.message}` : `⚠️ ${res.message}`);
            return;
        }

        // 1. @ commands & help
        if (lower === "/help" || lower === "/commands" || lower === "/get-commands") {
            await this.sendMessage(chatId, buildCommandsHelp(this.settings));
            return;
        }

        // Ollama CLI @make
        if (lower.startsWith("/make") || lower === "/make") {
            const promptText = msgText.slice(5).trim();
            if (!promptText) {
                await this.sendMessage(chatId, "⚠️ Usage: @make <project description>\nExample: @make Create a python script in server.py");
                return;
            }
            await this.sendMessage(chatId, `🔨 Running Ollama CLI coding agent for: "${promptText}"...`);
            const res = await runMakeCommand(promptText, this.settings);
            await this.sendMessage(chatId, res.output || "🔨 Project task completed!");
            return;
        }

        // Ollama CLI @create-file
        if (lower.startsWith("/create-file") || lower === "/create-file") {
            const payload = msgText.slice(12).trim();
            if (!payload) {
                await this.sendMessage(chatId, "⚠️ Usage: @create-file <file_path> [content|prompt]");
                return;
            }
            const firstSpaceIdx = payload.search(/\s/);
            let filePath = payload;
            let contentOrPrompt = "";
            if (firstSpaceIdx !== -1) {
                filePath = payload.slice(0, firstSpaceIdx).trim();
                contentOrPrompt = payload.slice(firstSpaceIdx + 1).trim();
            }
            await this.sendMessage(chatId, `📄 Processing file creation for ${filePath}...`);
            const res = await runCreateFileCommand(filePath, contentOrPrompt, this.settings);
            await this.sendMessage(chatId, res.success ? `📄 ${res.output}` : `⚠️ ${res.error}`);
            return;
        }

        // OpenCLI @opencli (owner-gated on Telegram)
        if (lower === "/opencli" || lower.startsWith("/opencli ")) {
            const taskText = msgText.slice(8).trim();
            if (!taskText) {
                await this.sendMessage(chatId, "⚠️ Usage: @opencli <project or coding task description>\nExample: @opencli Scaffold a bun + sqlite todo API in ./todo-api with tests");
                return;
            }
            const gate = checkOpenCliAccess(this.settings, chatId);
            if (!gate.allowed) {
                await this.sendMessage(chatId, gate.reason);
                return;
            }
            await this.sendMessage(chatId, `🤖 Running OpenAI coding agent for: "${taskText}"...`);
            const res = await runOpenCliCommand(taskText, this.settings, { senderId: chatId });
            await this.sendMessage(chatId, res.success ? `🤖 ${res.output}` : `⚠️ ${res.error}`);
            return;
        }

        // opencode CLI auto-allow alias - @opencode-setup-auto-allow [mode] (owner-gated on Telegram)
        if (lower === "/opencode-setup-auto-allow" || lower.startsWith("/opencode-setup-auto-allow ")) {
            const gate = checkOpencodeAccess(this.settings, chatId);
            if (!gate.allowed) {
                await this.sendMessage(chatId, gate.reason);
                return;
            }
            const modeArgs = msgText.slice(26).trim();
            try {
                const res = await runOpencodeSetupStep(`auto-allow ${modeArgs}`.trim(), this.settings, { senderId: chatId });
                if (res.settingsChanged) {
                    try { saveSettings(this.settings); } catch {}
                }
                await this.sendMessage(chatId, truncateOpencodeForChat(res.reply));
            } catch (err) {
                await this.sendMessage(chatId, `⚠️ @opencode-setup-auto-allow error: ${err.message || err}`);
            }
            return;
        }

        // opencode CLI guided setup - @opencode-setup [...] (owner-gated on Telegram)
        if (lower === "/opencode-setup" || lower.startsWith("/opencode-setup ")) {
            const gate = checkOpencodeAccess(this.settings, chatId);
            if (!gate.allowed) {
                await this.sendMessage(chatId, gate.reason);
                return;
            }
            const stepArgs = msgText.slice(15).trim();
            try {
                const res = await runOpencodeSetupStep(stepArgs, this.settings, { senderId: chatId });
                if (res.settingsChanged) {
                    try { saveSettings(this.settings); } catch {}
                }
                await this.sendMessage(chatId, truncateOpencodeForChat(res.reply));
            } catch (err) {
                await this.sendMessage(chatId, `⚠️ @opencode-setup error: ${err.message || err}`);
            }
            return;
        }

        // opencode CLI model - @opencode-model [<model>]
        if (lower === "/opencode-model" || lower.startsWith("/opencode-model ")) {
            const gate = checkOpencodeAccess(this.settings, chatId);
            if (!gate.allowed) {
                await this.sendMessage(chatId, gate.reason);
                return;
            }
            const arg = msgText.slice(15).trim();
            if (!arg) {
                let projectPath = null;
                try {
                    projectPath = requireExplicitProjectPath(this.settings);
                } catch {}
                const eff = getEffectiveOpencodeModel(this.settings || {}, projectPath);
                await this.sendMessage(chatId, `🤖 @opencode model: ${eff.model || "(opencode default)"} [${eff.source}]\n💡 Set it: @opencode-model <provider/model>`);
                return;
            }
            this.settings.opencode_model = arg;
            try { saveSettings(this.settings); } catch {}
            await this.sendMessage(chatId, `🤖 @opencode model set to "${arg}".`);
            return;
        }

        // opencode CLI @opencode (owner-gated on Telegram)
        if (lower === "/opencode" || lower.startsWith("/opencode ")) {
            const taskText = msgText.slice(9).trim();
            if (!taskText) {
                await this.sendMessage(chatId, "⚠️ Usage: @opencode <project or coding task description>\nNeeds @set-project-path <dir> first; model via @opencode-model or opencode's own config.");
                return;
            }
            const gate = checkOpencodeAccess(this.settings, chatId);
            if (!gate.allowed) {
                await this.sendMessage(chatId, gate.reason);
                return;
            }
            let startInfo = {};
            try {
                const pp = requireExplicitProjectPath(this.settings);
                const eff = getEffectiveOpencodeModel(this.settings || {}, pp);
                startInfo = { projectPath: pp, model: eff.model || "(opencode default)", modelSource: eff.source };
            } catch {}
            await this.sendMessage(chatId, formatOpencodeStart(taskText, startInfo));
            const res = await runOpencodeCommand(taskText, this.settings, { senderId: chatId });
            await this.sendMessage(chatId, truncateOpencodeForChat(formatOpencodeFinish(taskText, res, res.elapsedMs ?? 0)));
            return;
        }

        // Agentic local browser - @youtube-play / @play (API-first, Chromium fallback)
        if (lower.startsWith("/youtube-play") || lower === "/play" || lower.startsWith("/play ")) {
            const parsed = parsePlayInput(cmdText);
            if (!parsed || !parsed.query) {
                await this.sendMessage(chatId, "⚠️ Usage: @youtube-play <search terms or YouTube URL> [--no-show]");
                return;
            }
            const st = getPlayStatus(this.settings);
            await this.sendMessage(chatId, `▶️ Playing YouTube for "${parsed.query}" via ${st.youtubeApi ? "YouTube Data API" : "local browser fallback"}...`);
            const res = await playYoutubeViaApi(parsed.query, this.settings, { show: parsed.show });
            await this.sendMessage(chatId, formatPlayResult(res));
            return;
        }

        // Agentic local browser - @spotify-play / @spotify (API-first, Chromium fallback)
        if (lower.startsWith("/spotify-play") || lower === "/spotify" || lower.startsWith("/spotify ")) {
            const parsed = parseSpotifyPlayInput(cmdText);
            if (!parsed || !parsed.query) {
                await this.sendMessage(chatId, "⚠️ Usage: @spotify-play <search terms or Spotify URL> [--no-show]");
                return;
            }
            const st = getPlayStatus(this.settings);
            await this.sendMessage(chatId, `🎧 Playing Spotify for "${parsed.query}" via ${st.spotifyApi ? "Spotify Web API" : "local browser fallback"}...`);
            const res = await playSpotifyViaApi(parsed.query, this.settings, { show: parsed.show });
            await this.sendMessage(chatId, formatSpotifyPlayResult(res));
            return;
        }

        // Blog drafts - @blog / @wordpress / @blogger / @post (API-first,
        // Chromium editor fallback) + natural "@Parsly, write a blog post
        // about ... on @wordpress/@blogger" callouts.
        const blogParsed = parseBlogInput(cmdText);
        if (blogParsed) {
            if (!blogParsed.topic) {
                await this.sendMessage(chatId, "⚠️ Usage: @blog <topic> [--on wordpress|blogger] [--title <title>] [--no-show]");
                return;
            }
            await this.sendMessage(chatId, `📝 Drafting blog post about "${blogParsed.topic}" (${blogParsed.platform}) in the voice of ${activeChar.name}...`);
            const res = await draftBlogViaApi(blogParsed.topic, this.settings, { platform: blogParsed.platform, title: blogParsed.title, show: blogParsed.show, settings: this.settings, ollamaClient: ollama || null, characterPersona: composeSystemTemplate(activeChar), characterName: activeChar.name });
            await this.sendMessage(chatId, formatBlogDraftResult(res));
            return;
        }
        const blogIntent = detectBlogIntent(msgText);
        if (blogIntent) {
            await this.sendMessage(chatId, `📝 Drafting blog post about "${blogIntent.topic}" (${blogIntent.platform}) in the voice of ${activeChar.name}...`);
            const res = await draftBlogViaApi(blogIntent.topic, this.settings, { platform: blogIntent.platform, show: true, settings: this.settings, ollamaClient: ollama || null, characterPersona: composeSystemTemplate(activeChar), characterName: activeChar.name });
            await this.sendMessage(chatId, formatBlogDraftResult(res));
            return;
        }

        // Fact-check - @fact-check / @factcheck / @verify (Semantic Scholar papers + optional Gemini verdict).
        const factParsed = parseFactCheckInput(cmdText, this.settings);
        if (factParsed) {
            if (!factParsed.claim) {
                await this.sendMessage(chatId, "⚠️ Usage: @fact-check <claim> [--limit N] [--source auto|papers|gemini]");
                return;
            }
            await this.sendMessage(chatId, `🔍 Fact-checking "${factParsed.claim}"...`);
            const res = await checkFactClaimViaApi(factParsed.claim, this.settings, { maxResults: factParsed.maxResults, source: factParsed.source, model: factParsed.model, verdict: factParsed.verdict });
            await this.sendMessage(chatId, formatFactCheckResult(res));
            return;
        }

        // Live web search - @live-web / @live-gemini / @web-search / @websearch / @web-fetch / @web-status
        // (inline "@live-web / @live-gemini within a sentence" is injected into LLM context below).
        {
            const { parseWebSearchCommand, parseWebFetchCommand, parseWebStatusCommand, searchWeb, formatWebResults, fetchPageText, formatPageText, formatWebStatus } = await import("./websearch.js");
            if (parseWebStatusCommand(msgText)) {
                await this.sendMessage(chatId, formatWebStatus(this.settings));
                return;
            }
            const webSearchCmd = parseWebSearchCommand(msgText, this.settings);
            if (webSearchCmd) {
                if (!webSearchCmd.query) {
                    await this.sendMessage(chatId, '⚠️ Usage: @web-search <query> [--provider auto|duckduckgo|brave|tavily|google-ai] [--limit N]\nInline forms: @live-web ("latest BTC price @live-web") or @live-gemini ("explain black holes @live-gemini")');
                    return;
                }
                await this.sendMessage(chatId, `🌐 Searching the live web for "${webSearchCmd.query}"...`);
                const res = await searchWeb(webSearchCmd.query, this.settings, { provider: webSearchCmd.provider, maxResults: webSearchCmd.maxResults });
                await this.sendMessage(chatId, formatWebResults(res));
                return;
            }
            const webFetchCmd = parseWebFetchCommand(msgText);
            if (webFetchCmd) {
                if (!webFetchCmd.url) {
                    await this.sendMessage(chatId, "⚠️ Usage: @web-fetch <url>");
                    return;
                }
                const res = await fetchPageText(webFetchCmd.url, this.settings);
                await this.sendMessage(chatId, formatPageText(res));
                return;
            }
        }

        // Agentic local browser - @browser-search / open / read / shot / status / close
        if (lower.startsWith("/browser-search-spotify ")) {
            const query = cmdText.slice("/browser-search-spotify".length).trim();
            if (!query) {
                await this.sendMessage(chatId, "⚠️ Usage: @browser-search-spotify <query>");
                return;
            }
            const res = await browserSearchSpotify(query, this.settings);
            if (!res.success || !res.results || res.results.length === 0) {
                await this.sendMessage(chatId, `⚠️ No results: ${(res && res.error) || "empty result set"}`);
            } else {
                await this.sendMessage(
                    chatId,
                    `🎧 Top Spotify results for "${query}":\n` +
                        res.results.map((r, i) => `${i + 1}. ${r.title} [${r.kind || "track"}]\n   ${r.url}`).join("\n")
                );
            }
            return;
        }

        if (lower.startsWith("/browser-search ")) {
            const query = cmdText.slice("/browser-search".length).trim();
            if (!query) {
                await this.sendMessage(chatId, "⚠️ Usage: @browser-search <query>");
                return;
            }
            const res = await browserSearchYoutube(query, this.settings);
            if (!res.success || !res.results || res.results.length === 0) {
                await this.sendMessage(chatId, `⚠️ No results: ${(res && res.error) || "empty result set"}`);
            } else {
                await this.sendMessage(
                    chatId,
                    `🌐 Top YouTube results for "${query}":\n` +
                        res.results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}`).join("\n")
                );
            }
            return;
        }

        if (lower.startsWith("/browser-open ")) {
            const url = cmdText.slice("/browser-open".length).trim();
            if (!url) {
                await this.sendMessage(chatId, "⚠️ Usage: @browser-open <url>");
                return;
            }
            const res = await browserOpen(url, this.settings);
            await this.sendMessage(chatId, res.success ? `🌐 Browser at: "${res.title || "(untitled)"}"\n🔗 ${res.url}` : `⚠️ ${res.error}`);
            return;
        }

        if (lower === "/browser-read") {
            const res = await browserRead(this.settings);
            if (!res.success) {
                await this.sendMessage(chatId, `⚠️ ${res.error}`);
            } else {
                for (const part of splitTelegramMessage(`🌐 [${res.title || res.url}]\n${res.text}`)) {
                    await this.sendMessage(chatId, part);
                }
            }
            return;
        }

        if (lower === "/browser-shot" || lower.startsWith("/browser-shot ")) {
            const res = await browserScreenshot(cmdText.slice("/browser-shot".length).trim(), this.settings);
            await this.sendMessage(chatId, res.success ? `📸 Screenshot saved: ${res.path}` : `⚠️ ${res.error}`);
            return;
        }

        if (lower === "/browser-status") {
            const st = await browserStatus(this.settings);
            await this.sendMessage(
                chatId,
                `🌐 Browser: ${st.launched ? "running" : "stopped"} (${st.headless ? "headless fallback" : "visible window"})` +
                    (st.url ? `\n🔗 ${st.title || ""} ${st.url}` : "") +
                    `\n✅ Allowed: ${st.allowed.join(", ")}`
            );
            return;
        }

        if (lower === "/browser-close") {
            await browserClose();
            await this.sendMessage(chatId, "🌐 Local browser closed.");
            return;
        }

        // TV cast (Castor-style DLNA, shared parser with CLI/WhatsApp).
        {
            const castParsed = parseCastInput(cmdText);
            if (castParsed) {
                if (["url", "player", "auto"].includes(castParsed.action)) {
                    await this.sendMessage(chatId, "📺 Working on the cast (extraction + TV handshake can take ~30s)...");
                }
                try {
                    const res = await runCastCommand(cmdText, this.settings);
                    if (res.settingsChanged) saveSettings(this.settings);
                    await this.sendMessage(chatId, res.reply);
                } catch (err) {
                    await this.sendMessage(chatId, `⚠️ Cast error: ${err.message || err}`);
                }
                return;
            }
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

        if (lower === "/ephemeral" || lower.startsWith("/ephemeral ") || lower === "/one-shot" || lower.startsWith("/one-shot ") || lower === "/oneshot" || lower.startsWith("/oneshot ")) {
            const { parseEphemeralToggleArg, formatEphemeralReply } = await import("./ollama_ephemeral.js");
            const parts = msgText.split(/\s+/);
            const action = parseEphemeralToggleArg(parts[1] || "");
            if (action === "invalid") {
                await this.sendMessage(chatId, "⚠️ Usage: @ephemeral [on|off|status] (or @one-shot)");
                return;
            }
            if (action === "on") this.settings.ollama_ephemeral = true;
            else if (action === "off") this.settings.ollama_ephemeral = false;
            try { saveSettings(this.settings); } catch {}
            await this.sendMessage(chatId, formatEphemeralReply(this.settings));
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
                await this.sendMessage(chatId, "⚠️ Usage: @pdf-to-md <filename.pdf>");
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

        // Memory (scoped to this bot's character; sim-aware)
        if (lower.startsWith("/remember ")) {
            const text = msgText.slice(10).trim();
            const simScopeTg = scopeKeyFor("telegram", activeChar.id, String(chatId));
            const simActiveTg = getActiveSimulation(simScopeTg);
            if (simActiveTg) {
                const mem = addSimulationMemory(simActiveTg.slug, { type: "fact", content: text, source: "user_remember_simulation", confidence: 1.0, importance: 0.8 });
                await this.sendMessage(chatId, `🎭🧠 Simulation memory saved inside "${simActiveTg.name}": "${text}"`);
                return;
            }
            remember(text, undefined, activeChar.id);
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

        // Needle on-device fast-path: local-action turns skip the main LLM
        // (executor already stored memory/task/note/timer entries).
        try {
            const fastPath = await tryNeedleFastPath(msgText, {
                settings: this.settings,
                characterStore: this.characterStore,
                activeCharacterId: activeChar.id,
            });
            if (fastPath && fastPath.handled) {
                const session = remoteSession("telegram", String(chatId), activeChar.id);
                const sessionMessages = session.messages || [];
                sessionMessages.push({ role: "user", content: msgText });
                sessionMessages.push({ role: "assistant", content: fastPath.reply });
                saveSession(session.id, sessionMessages, activeChar.id);
                await this.sendMessage(chatId, fastPath.reply);
                return;
            }
        } catch {}

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

        const learningPipeline = getLearningPipeline();
        // Simulation augmentation (active sim frame + local/archive recall).
        const simAug = getSimulationChatAugmentation(queryText, {
            platform: "telegram",
            characterId: activeChar.id,
            personaName: activeChar.name,
            chatId: String(chatId),
        });
        const simActive = simAug.activeSim;
        if (!simActive) {
            learningPipeline.extractHeuristic(msgText, activeChar.id);
        }

        const modelMessages = [];

        // System prompt from persona profile
        const systemPromptText = composeSystemTemplate(activeChar);
        if (systemPromptText) {
            modelMessages.push({ role: "system", content: systemPromptText });
        }
        for (const block of simAug.blocks.slice(0, simActive ? 1 : 0)) {
            // Active-sim frame goes right after the persona prompt.
            modelMessages.push({ role: "system", content: block });
        }

        // Relevant memories (scoped to this bot's character + active language;
        // same-language pool + shared first, other languages via bridge)
        const memories = retrieveMemories(queryText, 5, undefined, activeChar.id);
        try {
            const { detectLanguage: _dl, buildLanguageScopeNote: _note } = await import("./language.js");
            const _det = _dl(queryText || "");
            if (_det.code && _det.code !== "und" && _det.code !== "shared") {
                const _bridges = memories.filter((m) => typeof m === "string" && m.includes("[via ")).length;
                const _scope = _note(_det.code, _bridges);
                if (_scope) modelMessages.push({ role: "system", content: _scope });
            }
        } catch {}
        if (memories.length > 0) {
            modelMessages.push({
                role: "system",
                content: `[Relevant Persistent Memories]:\n${memories.map((m) => `• ${m}`).join("\n")}`,
            });
        }
        // Simulation-local + archive blocks (remaining augmentation blocks).
        for (const block of simAug.blocks.slice(simActive ? 1 : 0)) {
            modelMessages.push({ role: "system", content: block });
        }

        // Daily self-reflections (association recall from data/reflections.json).
        try {
            const { getReflectionChatAugmentation } = await import("./reflections.js");
            const refAug = getReflectionChatAugmentation(queryText, { characterId: activeChar.id, limit: 3 });
            if (refAug.block) modelMessages.push({ role: "system", content: refAug.block });
        } catch {}

        // Relevant knowledge base
        const relevantKnowledge = retrieveKnowledge(queryText, 4);
        if (relevantKnowledge.length > 0) {
            modelMessages.push({
                role: "system",
                content: `[Relevant Knowledge Base]:\n${relevantKnowledge.map((k) => `• [${k.knowledge.title} (${k.knowledge.category})]: ${k.knowledge.content}`).join("\n")}`,
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

        // Live web search ("@live-web" anywhere in the sentence): inject
        // real-time results as system context for any provider.
        try {
            const { runWebSearchForPrompt } = await import("./websearch.js");
            const webHit = await runWebSearchForPrompt(queryText, this.settings);
            if (webHit.triggered && webHit.block) {
                modelMessages.push({ role: "system", content: webHit.block });
            }
        } catch {}

        // Add recent session history (simulation archive while active)
        const recentHistory = simActive && simAug.historyOverride
            ? simAug.historyOverride.slice(-6)
            : sessionMessages.slice(-6);
        for (const h of recentHistory) {
            if (h.role === "user" || h.role === "assistant") {
                modelMessages.push({ role: h.role, content: h.content });
            }
        }

        modelMessages.push({ role: "user", content: queryText });

        try {
            const response = await unifiedChat({
                modelName: this.settings.model,
                messages: modelMessages,
                stream: false,
                settings: this.settings,
                ollamaClient: ollama,
            });

            const reply = response.content || "No response received.";
            await this.sendMessage(chatId, reply);

            if (simActive) {
                try {
                    appendSimulationExchange(simActive.slug, msgText, reply);
                    extractSimulationHeuristic(simActive.slug, msgText);
                } catch {}
            } else {
                // Save conversation back to session
                sessionMessages.push({ role: "user", content: msgText });
                sessionMessages.push({ role: "assistant", content: reply });
                saveSession(session.id, sessionMessages, activeChar.id);

                // Trigger background incremental learning extraction (scoped to this bot's character)
                if (this.settings.auto_learning_enabled !== false) {
                    const historyContext = sessionMessages.slice(-6).map((m) => `${m.role}: ${m.content}`).join("\n");
                    learningPipeline.extractWithLLM(msgText, reply, historyContext, {
                        settings: this.settings,
                        ollamaClient: ollama,
                        characterId: activeChar.id,
                    }).catch(() => {});
                }

                // Adaptive auto-insight (background, never blocks the reply).
                try {
                    const { maybeAutoInsight } = await import("./auto_insight.js");
                    maybeAutoInsight({
                        settings: this.settings,
                        characterId: activeChar.id,
                        personaName: activeChar.name,
                        userText: msgText,
                        sessionMessages,
                        ollamaClient: ollama,
                    }).catch(() => {});
                } catch {}
            }

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
        // Guard against double-start: a second start() on the same instance
        // would spawn a second concurrent getUpdates loop on the same token,
        // which Telegram kills with 409 "terminated by other getUpdates".
        if (this.running) {
            return false;
        }

        const me = await this.apiCall("getMe");
        if (!me.ok) {
            console.log(`⚠️ Telegram Bot connection failed for persona "${this.characterProfile.name}": ${me.description || me.error}`);
            return false;
        }

        console.log(`✈️ Telegram Bot active for persona "${this.characterProfile.name}" (@${me.result.username})`);
        this.running = true;
        // Generation guard: if stop() aborts the in-flight fetch and a new
        // start() begins, the stale loop sees a mismatched generation and exits
        // instead of polling concurrently with the new loop.
        const generation = (this.pollGeneration = (this.pollGeneration || 0) + 1);
        this.pollAbort = null;
        this.seenUpdateIds = this.seenUpdateIds || new Set();
        let consecutiveErrors = 0;

        // Long polling loop (exactly one per runner instance)
        (async () => {
            while (this.running && this.pollGeneration === generation) {
                const controller = new AbortController();
                this.pollAbort = controller;
                try {
                    const res = await this.apiCall("getUpdates", {
                        offset: this.lastUpdateId ? this.lastUpdateId + 1 : 0,
                        timeout: 20,
                    }, { signal: controller.signal });

                    if (!this.running || this.pollGeneration !== generation) break;

                    if (res.aborted) break;

                    if (!res.ok) {
                        consecutiveErrors += 1;
                        const desc = String(res.description || res.error || "");
                        // 409 Conflict = another getUpdates loop is polling this
                        // token (duplicate poller). Back off and let the owner
                        // keep the token instead of hammering Telegram.
                        if (res.error_code === 409 || /terminated by other getUpdates|conflict/i.test(desc)) {
                            console.log(`⚠️ Telegram polling conflict for persona "${this.characterProfile?.name || "?"}": another getUpdates session owns this token — stopping duplicate poller.`);
                            this.running = false;
                            break;
                        }
                        // 429 rate-limit: honor Telegram's retry_after, with a floor.
                        const retryAfter = Number(res.parameters?.retry_after);
                        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
                            ? Math.min(retryAfter * 1000, 60000)
                            : Math.min(1000 * Math.pow(2, Math.min(consecutiveErrors, 5)), 30000);
                        await new Promise((r) => setTimeout(r, waitMs));
                        continue;
                    }

                    consecutiveErrors = 0;
                    if (Array.isArray(res.result)) {
                        for (const update of res.result) {
                            if (!this.running || this.pollGeneration !== generation) break;
                            if (update == null || typeof update.update_id !== "number") continue;
                            // Dedupe: brief overlaps (stop+rewake, stale loop
                            // teardown) must never double-reply / double-LLM.
                            if (this.seenUpdateIds.has(update.update_id)) continue;
                            this.seenUpdateIds.add(update.update_id);
                            if (this.seenUpdateIds.size > 1000) {
                                const oldest = [...this.seenUpdateIds].slice(0, this.seenUpdateIds.size - 1000);
                                for (const id of oldest) this.seenUpdateIds.delete(id);
                            }
                            this.lastUpdateId = update.update_id;
                            await this.handleUpdate(update);
                        }
                    }
                } catch (err) {
                    if (!this.running || this.pollGeneration !== generation) break;
                    consecutiveErrors += 1;
                    await new Promise((r) => setTimeout(r, Math.min(1000 * Math.pow(2, Math.min(consecutiveErrors, 5)), 30000)));
                } finally {
                    if (this.pollAbort === controller) this.pollAbort = null;
                }
            }
        })();

        return true;
    }

    stop() {
        this.running = false;
        // Abort the in-flight long-poll so a stopped runner doesn't linger
        // for up to `timeout` seconds and overlap with its replacement.
        try { this.pollAbort?.abort(); } catch {}
        this.pollAbort = null;
    }
}

/**
 * Starts Telegram bot instances for all persona profiles defined in characters.json
 * that have a telegram_token (or global fallback token in app_settings.json).
 */
export async function startAllTelegramBots({ characterStore, settings, fallbackToken = "", proactiveManager = null, onlyActive = false, onActivity = null }) {
    const botsConfig = getAllCharacterTelegramBots(characterStore, fallbackToken || settings.telegram_token || process.env.TELEGRAM_TOKEN);
    const activeRunners = [];

    if (botsConfig.length === 0) {
        console.log("✈️ Telegram Bridge: Disabled/Inactive (No bot tokens configured. Use /set-telegram-token <token> or TELEGRAM_TOKEN env var).");
        return activeRunners;
    }

    const filtered = onlyActive && characterStore?.active_character
        ? botsConfig.filter((c) => String(c.character.id) === String(characterStore.active_character))
        : botsConfig;
    if (filtered.length === 0) {
        console.log(`✈️ Telegram Bridge: active persona "${characterStore?.active_character}" has no bot token — polling paused until @wake or @character.`);
        return activeRunners;
    }

    for (const cfg of filtered) {
        const runner = new TelegramBotRunner({
            token: cfg.token,
            characterProfile: cfg.character,
            characterStore,
            settings,
            proactiveManager,
            onActivity,
        });
        const ok = await runner.start();
        if (ok) {
            activeRunners.push(runner);
        }
    }

    return activeRunners;
}
