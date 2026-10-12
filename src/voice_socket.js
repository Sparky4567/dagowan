import fs from "node:fs";
import path from "node:path";
import ollama from "ollama";
import { unifiedChat } from "./providers.js";
import { transcribeAudio, synthesizeSpeech, cleanMarkdownToText } from "./audio.js";
import { loadSettings, saveSettings, exportSettings, importSettings } from "./config.js";
import { loadCharacterStore, getActiveCharacter, composeSystemTemplate } from "./characters.js";
import { loadSession, createSession, saveSession, retrieveSessionContext, listSessions } from "./sessions.js";
import { loadMemories, remember, retrieveMemories } from "./memory.js";
import { retrieveKnowledge } from "./knowledge.js";
import { getLearningPipeline, getLearningStats } from "./learning.js";
import { DEFAULT_MODELS, getApiKey } from "./providers.js";
import {
    registerTask,
    formatActiveTasks,
    moveTask,
    deleteTask,
    parseMoveTaskCommand,
    parseDeleteTaskCommand,
} from "./tasks.js";
import { convertNotesToPdf, convertPdfToMd } from "./pdf_utils.js";
import { runMakeCommand, runCreateFileCommand } from "./ollama_coding.js";
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
import { playSpotify as playSpotifyViaApi, playYoutube as playYoutubeViaApi } from "./play_api.js";
import { detectBlogIntent, draftBlog as draftBlogViaApi } from "./blog_api.js";
import { checkFactClaim as checkFactClaimViaApi, formatFactCheckResult, parseFactCheckInput } from "./factcheck_api.js";
import { parseCastInput, runCastCommand } from "./cast/caster.js";
import { buildCommandsHelp } from "./commands.js";
import { runOpenCliCommand } from "./opencli.js";
import { runOpencodeCommand, getEffectiveOpencodeModel, requireExplicitProjectPath, runOpencodeSetupStep, formatOpencodeStart, formatOpencodeFinish } from "./opencode.js";
import {
    WEB_SCOPE,
    DEFAULT_UNLOCK_MINUTES,
    OTP_KEYS,
    SECURITY_PIN_KEYS,
    isProbablyControlCommand,
    isSurfaceLocked,
    lockedMessage,
    runOtpCommand,
    runSecurityCommand,
} from "./security.js";
import { tryNeedleFastPath } from "./needle.js";
import { logPrompt } from "./logger.js";
import {
    addSimulationMemory,
    appendSimulationExchange,
    extractSimulationHeuristic,
    getActiveSimulation,
    getSimulationChatAugmentation,
    handleSimulationBridgeCommand,
    scopeKeyFor,
} from "./simulation.js";

const PORT = Number(process.env.VOICE_PORT || process.env.WEB_PORT || 8767);
const BIND_HOST = process.env.BIND_HOST || process.env.HOST || "0.0.0.0";

export class LocalVoiceSocketBridge {
    constructor({ settings = null, characterStore = null, services = {} } = {}) {
        this.settings = settings || loadSettings();
        this.characterStore = characterStore || loadCharacterStore();
        this.server = null;
        this.activeWs = new Set();
        this.services = {
            transcribeAudio: services.transcribeAudio || transcribeAudio,
            synthesizeSpeech: services.synthesizeSpeech || synthesizeSpeech,
            unifiedChat: services.unifiedChat || unifiedChat,
        };
    }

    send(ws, payload) {
        try {
            if (!ws || typeof ws.send !== "function") return;
            // Bun's ServerWebSocket exposes readyState === 1 when open, but
            // some wrappers omit it — treat undefined as open and let send
            // throw (caught below) rather than dropping replies silently.
            const rs = ws.readyState;
            if (rs !== undefined && rs !== 1 && rs !== WebSocket.OPEN) return;
            ws.send(typeof payload === "string" ? payload : JSON.stringify(payload));
        } catch (err) {
            console.warn("⚠️ [Voice Socket] Send notice (socket closed or disconnected):", err.message);
        }
    }

    // Turn-scoped interruption: every query is a turn, and an interrupt
    // cancels only turns that already started — never a prompt the user
    // sends afterwards. (A single shared boolean could not tell a stale
    // interrupt from a fresh one, so an interrupt arriving mid-flight
    // silently killed the next prompt too, hanging the UI in "thinking".)
    nextTurn(ws) {
        if (!ws) return 0;
        ws.turnSeq = (ws.turnSeq || 0) + 1;
        return ws.turnSeq;
    }

    interruptTurn(ws) {
        if (!ws) return;
        ws.cancelSeq = ws.turnSeq || 0;
    }

    turnAborted(ws, myTurn) {
        if (!ws) return true;
        const rs = ws.readyState;
        if (rs !== undefined && rs !== 1 && rs !== WebSocket.OPEN) return true;
        return (ws.cancelSeq || 0) >= (myTurn || 0);
    }

    // Returns true when this turn was cancelled (or the socket went away).
    // Only the latest turn emits terminal events — superseded turns stay
    // silent because the newer turn owns the UI. Without the terminal
    // events the webview would wait for an answer forever.
    checkAborted(ws, myTurn, notice = "⏸ Interrupted.") {
        if (!this.turnAborted(ws, myTurn)) return false;
        if (ws && myTurn === (ws.turnSeq || 0)) {
            this.send(ws, { event: "state_change", state: "idle" });
            if (notice) this.send(ws, { event: "llm_complete", text: notice });
        }
        return true;
    }

    // Shared TTS dispatch for main-LLM and Needle fast-path replies.
    async speakReply(ws, text, myTurn = null) {
        const turn = myTurn ?? (ws ? ws.turnSeq || 0 : 0);
        // Browser TTS is rendered client-side from the llm_complete event —
        // synthesizing server-side audio too would waste a slow local/remote
        // TTS call per reply (blocking later prompts) and the client would
        // discard the blob anyway. Just release the orb.
        if ((this.settings?.tts_engine || "local").toLowerCase() === "browser") {
            if (ws && turn === (ws.turnSeq || 0)) {
                this.send(ws, { event: "state_change", state: "idle" });
            }
            return;
        }
        // A superseded turn must not burn a full synthesis (which would
        // delay the newer turn sharing this event loop) — exit silently.
        if (this.turnAborted(ws, turn)) {
            if (ws && turn === (ws.turnSeq || 0)) {
                this.send(ws, { event: "state_change", state: "idle" });
            }
            return;
        }
        try {
            this.send(ws, { event: "state_change", state: "speaking" });
            const tmpAudioDir = path.join(process.cwd(), "tmp");
            if (!fs.existsSync(tmpAudioDir)) fs.mkdirSync(tmpAudioDir, { recursive: true });

            const voiceWavPath = path.join(tmpAudioDir, `ws_reply_${Date.now()}.wav`);
            await this.services.synthesizeSpeech(text, voiceWavPath, this.settings);

            if (this.turnAborted(ws, turn)) {
                console.log("⏸ [Voice Socket]: Skipping TTS audio dispatch due to user interruption or disconnect.");
                if (fs.existsSync(voiceWavPath)) try { fs.unlinkSync(voiceWavPath); } catch (_) {}
                // The text reply was already delivered above; just un-stick
                // the orb when this is still the latest turn.
                if (ws && turn === (ws.turnSeq || 0)) {
                    this.send(ws, { event: "state_change", state: "idle" });
                }
                return;
            }

            if (fs.existsSync(voiceWavPath)) {
                const wavBuffer = fs.readFileSync(voiceWavPath);
                try { fs.unlinkSync(voiceWavPath); } catch (_) {}

                const base64Wav = wavBuffer.toString("base64");
                this.send(ws, { event: "tts_audio", audio: base64Wav, format: "wav" });
            } else {
                this.send(ws, { event: "state_change", state: "idle" });
            }
        } catch (ttsErr) {
            console.error("⚠️ Voice Socket TTS Error:", ttsErr.message);
            this.send(ws, { event: "state_change", state: "idle" });
        }
    }

    // Terminal reply for executed @ commands (text-only, like the
    // @opencli/@opencode branches: tool output is code/logs, not speech).
    // Saves the turn to the session and un-sticks the UI.
    answerCommand(ws, { text, session, sessionMessages, activeChar, reply }) {
        sessionMessages.push({ role: "user", content: text });
        sessionMessages.push({ role: "assistant", content: reply });
        try { saveSession(session.id, sessionMessages, activeChar.id); } catch {}
        this.send(ws, { event: "state_change", state: "idle" });
        this.send(ws, { event: "llm_complete", text: reply });
    }

    async processVoiceQuery(ws, audioBase64, mimeType = null, chatId = "web_voice_session") {
        const myTurn = this.nextTurn(ws); // This prompt is immune to earlier interrupts
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
            // 1. STT Transcription (Local Whisper or OpenAI API based on settings)
            this.send(ws, { event: "state_change", state: "transcribing" });
            const sttRes = await this.services.transcribeAudio(audioFilePath, {}, this.settings);
            const userText = (sttRes.text || "").trim();

            if (this.checkAborted(ws, myTurn, "⏸ Interrupted before transcription finished.")) return;

            if (!userText) {
                this.send(ws, { event: "state_change", state: "idle" });
                this.send(ws, { event: "llm_complete", text: "⚠️ Could not detect speech in audio." });
                return;
            }

            // Show message on server terminal & log prompt
            console.log(`🌐 [Web View Voice]: "${userText}"`);
            logPrompt(userText, "web_voice");

            // Send transcribed text event
            this.send(ws, { event: "stt_transcript", text: userText });

            // Security PIN + OTP gate (same as text path): management commands
            // work while locked; any other control-shaped text — including
            // @help/@commands — needs @otp-login (+ @unlock) first.
            {
                const voiceSec = runSecurityCommand(userText, this.settings, WEB_SCOPE);
                if (voiceSec.handled) {
                    if (voiceSec.settingsChanged) {
                        try { saveSettings(this.settings); } catch {}
                    }
                    this.send(ws, { event: "state_change", state: "idle" });
                    this.send(ws, { event: "llm_complete", text: voiceSec.reply });
                    return;
                }
                const voiceOtp = runOtpCommand(userText, this.settings, WEB_SCOPE);
                if (voiceOtp.handled) {
                    if (voiceOtp.settingsChanged) {
                        try { saveSettings(this.settings); } catch {}
                    }
                    this.send(ws, { event: "state_change", state: "idle" });
                    this.send(ws, { event: "llm_complete", text: voiceOtp.reply });
                    return;
                }
                if (isSurfaceLocked(this.settings, WEB_SCOPE)) {
                    const voiceChars = (this.characterStore && this.characterStore.characters) || [];
                    if (isProbablyControlCommand(userText, voiceChars) || detectBlogIntent(userText)) {
                        this.send(ws, { event: "state_change", state: "idle" });
                        this.send(ws, { event: "llm_complete", text: lockedMessage(this.settings, WEB_SCOPE) });
                        return;
                    }
                }
            }

            const lowerVoice = userText.toLowerCase();
            if (
                lowerVoice === "@commands" ||
                lowerVoice === "@help" ||
                lowerVoice === "@get-commands" ||
                lowerVoice === "/commands" ||
                lowerVoice === "/help" ||
                lowerVoice === "/get-commands"
            ) {
                this.send(ws, { event: "state_change", state: "idle" });
                this.send(ws, { event: "llm_complete", text: buildCommandsHelp(this.settings) });
                return;
            }

            this.send(ws, { event: "state_change", state: "thinking" });

            // Needle on-device fast-path: local-action turns skip the main
            // LLM; the reply is still spoken via TTS. Returns early so the
            // heuristic + LLM + background-learn flow below is skipped (the
            // executor already stored the canonical entries).
            try {
                const fastPath = await tryNeedleFastPath(userText, {
                    settings: this.settings,
                    activeCharacterId: activeChar.id,
                });
                if (fastPath && fastPath.handled) {
                    sessionMessages.push({ role: "user", content: userText });
                    sessionMessages.push({ role: "assistant", content: fastPath.reply });
                    saveSession(session.id, sessionMessages, activeChar.id);
                    this.send(ws, { event: "llm_complete", text: fastPath.reply });
                    await this.speakReply(ws, fastPath.reply, myTurn);
                    return;
                }
            } catch {}

            const learningPipeline = getLearningPipeline();
            learningPipeline.extractHeuristic(userText, activeChar.id);

            // 2. Assemble LLM prompt
            const modelMessages = [];
            const systemPromptText = composeSystemTemplate(activeChar);
            if (systemPromptText) {
                modelMessages.push({ role: "system", content: systemPromptText });
            }

            const relevantMemories = retrieveMemories(userText, 5, undefined, activeChar.id);
            try {
                const { detectLanguage: _dl, buildLanguageScopeNote: _note } = await import("./language.js");
                const _det = _dl(userText || "");
                if (_det.code && _det.code !== "und" && _det.code !== "shared") {
                    const _bridges = relevantMemories.filter((m) => typeof m === "string" && m.includes("[via ")).length;
                    const _scope = _note(_det.code, _bridges);
                    if (_scope) modelMessages.push({ role: "system", content: _scope });
                }
            } catch {}
            if (relevantMemories.length > 0) {
                modelMessages.push({
                    role: "system",
                    content: `[Relevant Persistent Memories]:\n${relevantMemories.map((m) => `• ${m}`).join("\n")}`,
                });
            }

            const relevantKnowledge = retrieveKnowledge(userText, 4);
            if (relevantKnowledge.length > 0) {
                modelMessages.push({
                    role: "system",
                    content: `[Relevant Knowledge Base]:\n${relevantKnowledge.map((k) => `• [${k.knowledge.title} (${k.knowledge.category})]: ${k.knowledge.content}`).join("\n")}`,
                });
            }

            // Live web search ("@live-web" anywhere in the sentence).
            try {
                const { runWebSearchForPrompt } = await import("./websearch.js");
                const webHit = await runWebSearchForPrompt(userText, this.settings);
                if (webHit.triggered && webHit.block) {
                    modelMessages.push({ role: "system", content: webHit.block });
                }
            } catch {}

            const historyWindow = sessionMessages.slice(-6);
            for (const h of historyWindow) {
                if (h.role === "user" || h.role === "assistant") {
                    modelMessages.push({ role: h.role, content: h.content });
                }
            }

            modelMessages.push({ role: "user", content: userText });

            // 3. Unified LLM Query
            const llmRes = await this.services.unifiedChat({
                modelName: this.settings.model,
                messages: modelMessages,
                stream: false,
                settings: this.settings,
                ollamaClient: ollama,
            });

            if (this.checkAborted(ws, myTurn)) return;

            const replyText = cleanMarkdownToText(llmRes.content || "No response generated.");

            sessionMessages.push({ role: "user", content: userText });
            sessionMessages.push({ role: "assistant", content: replyText });
            saveSession(session.id, sessionMessages, activeChar.id);

            // Trigger background incremental learning extraction (scoped to active character)
            if (this.settings.auto_learning_enabled !== false) {
                const historyContext = sessionMessages.slice(-6).map((m) => `${m.role}: ${m.content}`).join("\n");
                learningPipeline.extractWithLLM(userText, replyText, historyContext, {
                    settings: this.settings,
                    ollamaClient: ollama,
                    characterId: activeChar.id,
                }).catch(() => {});
            }

            this.send(ws, { event: "llm_complete", text: replyText });

            // 4. TTS Speech Synthesis shares speakReply() (also used by the Needle fast-path above).
            await this.speakReply(ws, replyText, myTurn);

        } catch (err) {
            console.error("⚠️ Local Voice Socket processing error:", err);
            this.send(ws, { event: "state_change", state: "idle" });
            this.send(ws, { event: "llm_complete", text: `⚠️ Voice Error: ${err.message}` });
        } finally {
            if (fs.existsSync(audioFilePath)) {
                try {
                    fs.unlinkSync(audioFilePath);
                } catch (_) {}
            }
        }
    }

    async processTextQuery(ws, userText, chatId = "web_voice_session") {
        const myTurn = this.nextTurn(ws); // This prompt is immune to earlier interrupts
        if (!userText || !userText.trim()) return;

        const trimmedText = userText.trim();
        console.log(`🌐 [Web View]: "${trimmedText}"`);

        try {
            logPrompt(trimmedText, "web");

            const activeChar = getActiveCharacter(this.characterStore);
            const session = loadSession(chatId, activeChar.id) || createSession(activeChar.id, "Voice Conversation");
            const sessionMessages = session.messages || [];

            this.send(ws, { event: "stt_transcript", text: trimmedText });

            // Security PIN + OTP: management commands work while locked; any other
            // control-shaped text — including @help/@commands/@get-commands —
            // needs @otp-login (+ @unlock when a PIN is set)
            // first (regular chat passes). The web scope is shared for the UI.
            {
                const webSec = runSecurityCommand(trimmedText, this.settings, WEB_SCOPE);
                if (webSec.handled) {
                    if (webSec.settingsChanged) {
                        try { saveSettings(this.settings); } catch {}
                    }
                    this.send(ws, { event: "state_change", state: "idle" });
                    this.send(ws, { event: "llm_complete", text: webSec.reply });
                    return;
                }
                const webOtp = runOtpCommand(trimmedText, this.settings, WEB_SCOPE);
                if (webOtp.handled) {
                    if (webOtp.settingsChanged) {
                        try { saveSettings(this.settings); } catch {}
                    }
                    this.send(ws, { event: "state_change", state: "idle" });
                    this.send(ws, { event: "llm_complete", text: webOtp.reply });
                    return;
                }
                if (isSurfaceLocked(this.settings, WEB_SCOPE)) {
                    const webChars = (this.characterStore && this.characterStore.characters) || [];
                    if (isProbablyControlCommand(trimmedText, webChars) || detectBlogIntent(trimmedText)) {
                        this.send(ws, { event: "state_change", state: "idle" });
                        this.send(ws, { event: "llm_complete", text: lockedMessage(this.settings, WEB_SCOPE) });
                        return;
                    }
                }
            }

            const lowerText = trimmedText.toLowerCase();
            if (
                lowerText === "@commands" ||
                lowerText === "@help" ||
                lowerText === "@get-commands" ||
                lowerText === "/commands" ||
                lowerText === "/help" ||
                lowerText === "/get-commands"
            ) {
                this.send(ws, { event: "state_change", state: "idle" });
                this.send(ws, { event: "llm_complete", text: buildCommandsHelp(this.settings) });
                return;
            }

            // Tool @ commands (same set as Telegram/WhatsApp: without these,
            // control text falls through to the LLM as chat and tools like
            // @youtube-play silently "do nothing" on Web / side panel).
            // Replies are text-only (no TTS): tool output is code/logs.
            {
                const cmdText = trimmedText.startsWith("@") ? "/" + trimmedText.slice(1) : trimmedText;
                const cmdLower = cmdText.toLowerCase();
                const done = (reply) => {
                    this.answerCommand(ws, { text: trimmedText, session, sessionMessages, activeChar, reply });
                };

                // Ollama CLI @make
                if (cmdLower.startsWith("/make") || cmdLower === "/make") {
                    const promptText = cmdText.slice(5).trim();
                    if (!promptText) {
                        done("⚠️ Usage: @make <project description>\nExample: @make Create a python script in server.py");
                        return;
                    }
                    const res = await runMakeCommand(promptText, this.settings);
                    done(res.output || "🔨 Project task completed!");
                    return;
                }

                // Ollama CLI @create-file
                if (cmdLower.startsWith("/create-file") || cmdLower === "/create-file") {
                    const payload = cmdText.slice(12).trim();
                    if (!payload) {
                        done("⚠️ Usage: @create-file <file_path> [content|prompt]");
                        return;
                    }
                    const firstSpaceIdx = payload.search(/\s/);
                    let filePath = payload;
                    let contentOrPrompt = "";
                    if (firstSpaceIdx !== -1) {
                        filePath = payload.slice(0, firstSpaceIdx).trim();
                        contentOrPrompt = payload.slice(firstSpaceIdx + 1).trim();
                    }
                    const res = await runCreateFileCommand(filePath, contentOrPrompt, this.settings);
                    done(res.success ? `📄 ${res.output}` : `⚠️ ${res.error}`);
                    return;
                }

                // @youtube-play / @play (API-first, Chromium fallback)
                if (cmdLower.startsWith("/youtube-play") || cmdLower === "/play" || cmdLower.startsWith("/play ")) {
                    const parsed = parsePlayInput(cmdText);
                    if (!parsed || !parsed.query) {
                        done("⚠️ Usage: @youtube-play <search terms or YouTube URL> [--no-show]");
                        return;
                    }
                    const res = await playYoutubeViaApi(parsed.query, this.settings, { show: parsed.show });
                    done(formatPlayResult(res));
                    return;
                }

                // @spotify-play / @spotify (API-first, Chromium fallback)
                if (cmdLower.startsWith("/spotify-play") || cmdLower === "/spotify" || cmdLower.startsWith("/spotify ")) {
                    const parsed = parseSpotifyPlayInput(cmdText);
                    if (!parsed || !parsed.query) {
                        done("⚠️ Usage: @spotify-play <search terms or Spotify URL> [--no-show]");
                        return;
                    }
                    const res = await playSpotifyViaApi(parsed.query, this.settings, { show: parsed.show });
                    done(formatSpotifyPlayResult(res));
                    return;
                }

                // Blog drafts - @blog / @wordpress / @blogger / @post + natural callouts
                {
                    const blogParsed = parseBlogInput(cmdText);
                    if (blogParsed) {
                        if (!blogParsed.topic) {
                            done("⚠️ Usage: @blog <topic> [--on wordpress|blogger] [--title <title>] [--no-show]");
                            return;
                        }
                        const res = await draftBlogViaApi(blogParsed.topic, this.settings, { platform: blogParsed.platform, title: blogParsed.title, show: blogParsed.show, settings: this.settings, ollamaClient: ollama || null, characterPersona: composeSystemTemplate(activeChar), characterName: activeChar.name });
                        done(formatBlogDraftResult(res));
                        return;
                    }
                    const blogIntent = detectBlogIntent(trimmedText);
                    if (blogIntent) {
                        const res = await draftBlogViaApi(blogIntent.topic, this.settings, { platform: blogIntent.platform, show: true, settings: this.settings, ollamaClient: ollama || null, characterPersona: composeSystemTemplate(activeChar), characterName: activeChar.name });
                        done(formatBlogDraftResult(res));
                        return;
                    }
                }

                // Fact-check - @fact-check / @factcheck / @verify
                {
                    const factParsed = parseFactCheckInput(cmdText, this.settings);
                    if (factParsed) {
                        if (!factParsed.claim) {
                            done("⚠️ Usage: @fact-check <claim> [--limit N] [--source auto|papers|gemini]");
                            return;
                        }
                        const res = await checkFactClaimViaApi(factParsed.claim, this.settings, { maxResults: factParsed.maxResults, source: factParsed.source, model: factParsed.model, verdict: factParsed.verdict });
                        done(formatFactCheckResult(res));
                        return;
                    }
                }

                // Live web search - @live-web / @web-search / @websearch / @web-fetch / @web-status
                // (inline "@live-web within a sentence" is injected into LLM context below).
                {
                    const { parseWebSearchCommand, parseWebFetchCommand, parseWebStatusCommand, searchWeb, formatWebResults, fetchPageText, formatPageText, formatWebStatus } = await import("./websearch.js");
                    if (parseWebStatusCommand(trimmedText)) {
                        done(formatWebStatus(this.settings));
                        return;
                    }
                    const webSearchCmd = parseWebSearchCommand(trimmedText, this.settings);
                    if (webSearchCmd) {
                        if (!webSearchCmd.query) {
                            done('⚠️ Usage: @web-search <query> [--provider auto|duckduckgo|brave|tavily] [--limit N]\nInline form: mention @live-web anywhere in a sentence ("latest BTC price @live-web")');
                            return;
                        }
                        const res = await searchWeb(webSearchCmd.query, this.settings, { provider: webSearchCmd.provider, maxResults: webSearchCmd.maxResults });
                        done(formatWebResults(res));
                        return;
                    }
                    const webFetchCmd = parseWebFetchCommand(trimmedText);
                    if (webFetchCmd) {
                        if (!webFetchCmd.url) {
                            done("⚠️ Usage: @web-fetch <url>");
                            return;
                        }
                        const res = await fetchPageText(webFetchCmd.url, this.settings);
                        done(formatPageText(res));
                        return;
                    }
                }

                // Local browser tools
                if (cmdLower.startsWith("/browser-search-spotify ")) {
                    const query = cmdText.slice("/browser-search-spotify".length).trim();
                    if (!query) {
                        done("⚠️ Usage: @browser-search-spotify <query>");
                        return;
                    }
                    const res = await browserSearchSpotify(query, this.settings);
                    done(!res.success || !res.results || res.results.length === 0
                        ? `⚠️ No results: ${(res && res.error) || "empty result set"}`
                        : `🎧 Top Spotify results for "${query}":\n` +
                            res.results.map((r, i) => `${i + 1}. ${r.title} [${r.kind || "track"}]\n   ${r.url}`).join("\n"));
                    return;
                }

                if (cmdLower.startsWith("/browser-search ")) {
                    const query = cmdText.slice("/browser-search".length).trim();
                    if (!query) {
                        done("⚠️ Usage: @browser-search <query>");
                        return;
                    }
                    const res = await browserSearchYoutube(query, this.settings);
                    done(!res.success || !res.results || res.results.length === 0
                        ? `⚠️ No results: ${(res && res.error) || "empty result set"}`
                        : `🌐 Top YouTube results for "${query}":\n` +
                            res.results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}`).join("\n"));
                    return;
                }

                if (cmdLower.startsWith("/browser-open ")) {
                    const url = cmdText.slice("/browser-open".length).trim();
                    if (!url) {
                        done("⚠️ Usage: @browser-open <url>");
                        return;
                    }
                    const res = await browserOpen(url, this.settings);
                    done(res.success ? `🌐 Browser at: "${res.title || "(untitled)"}"\n🔗 ${res.url}` : `⚠️ ${res.error}`);
                    return;
                }

                if (cmdLower === "/browser-read") {
                    const res = await browserRead(this.settings);
                    done(res.success ? `🌐 [${res.title || res.url}]\n${res.text}` : `⚠️ ${res.error}`);
                    return;
                }

                if (cmdLower === "/browser-shot" || cmdLower.startsWith("/browser-shot ")) {
                    const res = await browserScreenshot(cmdText.slice("/browser-shot".length).trim(), this.settings);
                    done(res.success ? `📸 Screenshot saved: ${res.path}` : `⚠️ ${res.error}`);
                    return;
                }

                if (cmdLower === "/browser-status") {
                    const st = await browserStatus(this.settings);
                    done(`🌐 Browser: ${st.launched ? "running" : "stopped"} (${st.headless ? "headless fallback" : "visible window"})` +
                        (st.url ? `\n🔗 ${st.title || ""} ${st.url}` : "") +
                        `\n✅ Allowed: ${st.allowed.join(", ")}`);
                    return;
                }

                if (cmdLower === "/browser-close") {
                    await browserClose();
                    done("🌐 Local browser closed.");
                    return;
                }

                // TV cast (Castor-style DLNA, shared parser with CLI/Telegram)
                {
                    const castParsed = parseCastInput(cmdText);
                    if (castParsed) {
                        try {
                            const res = await runCastCommand(cmdText, this.settings);
                            if (res.settingsChanged) {
                                try { saveSettings(this.settings); } catch {}
                            }
                            done(res.reply);
                        } catch (err) {
                            done(`⚠️ Cast error: ${err.message || err}`);
                        }
                        return;
                    }
                }

                // Voice reply toggle
                if (cmdLower.startsWith("/voice-reply") || cmdLower === "/voicereply" || cmdLower.startsWith("/voice-mode") || cmdLower === "/voicemode") {
                    const parts = trimmedText.split(/\s+/);
                    const arg = (parts[1] || "").toLowerCase();
                    if (arg === "on" || arg === "true" || arg === "1") {
                        this.settings.voice_reply_enabled = true;
                    } else if (arg === "off" || arg === "false" || arg === "0") {
                        this.settings.voice_reply_enabled = false;
                    } else {
                        this.settings.voice_reply_enabled = !this.settings.voice_reply_enabled;
                    }
                    done(`🔊 Automatic Local Voice Reply / Voice Mode is now: ${this.settings.voice_reply_enabled ? "ENABLED (ON)" : "DISABLED (OFF)"}`);
                    return;
                }

                // PDF conversion
                if (cmdLower.startsWith("/convert-pdf") || cmdLower.startsWith("/pdf")) {
                    const parts = trimmedText.split(/\s+/);
                    const res = convertNotesToPdf("notes", "pdfs", parts[1] || "", parts[2] || "");
                    done(res.success ? `📄 ${res.output}` : `⚠️ ${res.error}`);
                    return;
                }

                if (cmdLower.startsWith("/pdf-to-md") || cmdLower.startsWith("/convert-md")) {
                    const parts = trimmedText.split(/\s+/);
                    const pdfFile = parts[1] || "";
                    if (!pdfFile) {
                        done("⚠️ Usage: @pdf-to-md <filename.pdf>");
                        return;
                    }
                    const res = convertPdfToMd(pdfFile, "notes");
                    done(res.success ? `📄 ${res.output}` : `⚠️ ${res.error}`);
                    return;
                }

                // Backup / Restore
                if (cmdLower.startsWith("/export-settings") || cmdLower.startsWith("/backup")) {
                    const backupPath = exportSettings();
                    done(`💾 Backup created: ${backupPath}`);
                    return;
                }

                if (cmdLower.startsWith("/import-settings") || cmdLower.startsWith("/restore")) {
                    const parts = trimmedText.split(/\s+/);
                    const res = importSettings(parts[1] || "");
                    done(res.success ? `✅ ${res.message}` : `⚠️ ${res.message}`);
                    return;
                }

                // Memory @remember (sim-aware, scoped to the active character)
                if (cmdLower.startsWith("/remember ")) {
                    const text = trimmedText.slice(10).trim();
                    if (text) {
                        const simScopeWeb = scopeKeyFor("web", activeChar.id, String(chatId));
                        const simActiveWebCmd = getActiveSimulation(simScopeWeb);
                        if (simActiveWebCmd) {
                            addSimulationMemory(simActiveWebCmd.slug, { type: "fact", content: text, source: "user_remember_simulation", confidence: 1.0, importance: 0.8 });
                            done(`🎭🧠 Simulation memory saved inside "${simActiveWebCmd.name}": "${text}"`);
                        } else {
                            remember(text, undefined, activeChar.id);
                            done(`🧠 Memory saved & context refreshed: "${text}"`);
                        }
                    } else {
                        done("⚠️ Please provide text to remember. Usage: @remember <text>");
                    }
                    return;
                }

                // Tasks
                if (cmdLower.startsWith("/register-task ")) {
                    const text = trimmedText.slice(15).trim();
                    const task = registerTask(text, "p");
                    done(`📋 Task "#${task.id}" registered into Processing (p) status.`);
                    return;
                }

                if (cmdLower === "/get-tasks" || cmdLower === "/tasks") {
                    done(formatActiveTasks());
                    return;
                }

                {
                    const moveInfo = parseMoveTaskCommand(trimmedText);
                    if (moveInfo) {
                        const res = moveTask(moveInfo.taskId, moveInfo.status);
                        done(res.success ? `📋 Task #${res.task.id} moved to ${res.task.status}.` : `⚠️ ${res.message}`);
                        return;
                    }
                }

                {
                    const delTaskId = parseDeleteTaskCommand(trimmedText);
                    if (delTaskId !== null) {
                        const res = deleteTask(delTaskId);
                        done(res.success ? `🗑 Task #${res.task.id} deleted.` : `⚠️ ${res.message}`);
                        return;
                    }
                }

                // Stats (read-only; also backs a side-panel quick button)
                if (cmdLower === "/stats" || cmdLower === "/learning-stats" || cmdLower === "/get-stats") {
                    const stats = getLearningStats();
                    const lines = [
                        `📊 AI Bot Persistent Learning & Database Stats:`,
                        `🧠 Active Memories:     ${stats.activeMemories}`,
                        `🔄 Superseded Memories: ${stats.supersededMemories}`,
                        `🗑 Forgotten Memories:  ${stats.forgottenMemories}`,
                        `📦 Total Memories:      ${stats.totalMemories}`,
                        `📚 Active Knowledge:    ${stats.activeKnowledge}`,
                        `✍️ User Corrections:    ${stats.corrections}`,
                        `🎯 Active Rules:        ${stats.activeRules}`,
                        `💡 Candidate Rules:     ${stats.candidateRules}`,
                        `📜 Learning Events:     ${stats.totalLearningLogs}`,
                    ];
                    done(lines.join("\n"));
                    return;
                }

                // Models (read-only; also backs a side-panel quick button)
                if (cmdLower === "/models") {
                    const lines = [`🤖 Available Multi-Provider LLM Models:`, `  🦙 Ollama (Local):`];
                    try {
                        const list = await ollama.list();
                        if (list.models && list.models.length > 0) {
                            for (const m of list.models) {
                                lines.push(`    • ${m.name}${m.name === this.settings.model ? " ★ (active)" : ""}`);
                            }
                        } else {
                            lines.push(`    (No local Ollama models installed)`);
                        }
                    } catch {
                        lines.push(`  🦙 Ollama (Local): Daemon offline or unreachable`);
                    }
                    for (const p of [
                        { id: "openai", title: "OpenAI ChatGPT", models: DEFAULT_MODELS.openai },
                        { id: "gemini", title: "Google Gemini", models: DEFAULT_MODELS.gemini },
                        { id: "claude", title: "Anthropic Claude", models: DEFAULT_MODELS.claude },
                        { id: "grok", title: "xAI Grok", models: DEFAULT_MODELS.grok },
                    ]) {
                        const key = getApiKey(p.id, this.settings);
                        lines.push(`  ⚡ ${p.title} [Status: ${key ? "configured" : "API key missing"}]:`);
                        for (const m of p.models) {
                            lines.push(`    • ${m}${m === this.settings.model ? " ★ (active)" : ""}`);
                        }
                    }
                    lines.push(`💡 Switch active model using: @model <model-name>`);
                    done(lines.join("\n"));
                    return;
                }

                // Sessions (read-only list; also backs a side-panel quick button)
                if (cmdLower === "/sessions") {
                    const all = listSessions(activeChar.id);
                    if (all.length === 0) {
                        done(`💬 No saved sessions for character "${activeChar.name}".`);
                    } else {
                        const lines = [`💬 Saved Sessions for "${activeChar.name}":`];
                        for (const s of all) {
                            lines.push(`  • [${s.id.slice(0, 8)}] ${s.title}${s.id === session.id ? " (active)" : ""} (${(s.messages || []).length} msgs)`);
                        }
                        done(lines.join("\n"));
                    }
                    return;
                }
            }

            // OpenCLI @opencli (Web UI is a local surface: allowed when enabled).
            // Text-only reply (no TTS): agent output is code/logs, not speech.
            {
                const cmdText = trimmedText.startsWith("@") ? "/" + trimmedText.slice(1) : trimmedText;
                const cmdLower = cmdText.toLowerCase();
                if (cmdLower === "/opencli" || cmdLower.startsWith("/opencli ")) {
                    const taskText = cmdText.slice(8).trim();
                    if (!taskText) {
                        this.send(ws, { event: "state_change", state: "idle" });
                        this.send(ws, { event: "llm_complete", text: "⚠️ Usage: @opencli <project or coding task description>" });
                        return;
                    }
                    this.send(ws, { event: "state_change", state: "thinking" });
                    try {
                        const res = await runOpenCliCommand(taskText, this.settings, { senderId: "web" });
                        const reply = res.success ? `🤖 ${res.output}` : `⚠️ ${res.error}`;
                        sessionMessages.push({ role: "user", content: trimmedText });
                        sessionMessages.push({ role: "assistant", content: reply });
                        saveSession(session.id, sessionMessages, activeChar.id);
                        this.send(ws, { event: "state_change", state: "idle" });
                        this.send(ws, { event: "llm_complete", text: reply });
                    } catch (err) {
                        this.send(ws, { event: "state_change", state: "idle" });
                        this.send(ws, { event: "llm_complete", text: `⚠️ @opencli error: ${err.message || err}` });
                    }
                    return;
                }
                if (cmdLower === "/opencode-setup-auto-allow" || cmdLower.startsWith("/opencode-setup-auto-allow ")) {
                    const modeArgs = cmdText.slice(26).trim();
                    this.send(ws, { event: "state_change", state: "thinking" });
                    try {
                        const res = await runOpencodeSetupStep(`auto-allow ${modeArgs}`.trim(), this.settings, { senderId: "web" });
                        if (res.settingsChanged) {
                            try { saveSettings(this.settings); } catch {}
                        }
                        this.send(ws, { event: "state_change", state: "idle" });
                        this.send(ws, { event: "llm_complete", text: res.reply });
                    } catch (err) {
                        this.send(ws, { event: "state_change", state: "idle" });
                        this.send(ws, { event: "llm_complete", text: `⚠️ @opencode-setup-auto-allow error: ${err.message || err}` });
                    }
                    return;
                }
                if (cmdLower === "/opencode-setup" || cmdLower.startsWith("/opencode-setup ")) {
                    const stepArgs = cmdText.slice(15).trim();
                    this.send(ws, { event: "state_change", state: "thinking" });
                    try {
                        const res = await runOpencodeSetupStep(stepArgs, this.settings, { senderId: "web" });
                        if (res.settingsChanged) {
                            try { saveSettings(this.settings); } catch {}
                        }
                        this.send(ws, { event: "state_change", state: "idle" });
                        this.send(ws, { event: "llm_complete", text: res.reply });
                    } catch (err) {
                        this.send(ws, { event: "state_change", state: "idle" });
                        this.send(ws, { event: "llm_complete", text: `⚠️ @opencode-setup error: ${err.message || err}` });
                    }
                    return;
                }
                if (cmdLower === "/opencode-model" || cmdLower.startsWith("/opencode-model ")) {
                    const arg = cmdText.slice(15).trim();
                    if (!arg) {
                        let projectPath = null;
                        try {
                            projectPath = requireExplicitProjectPath(this.settings);
                        } catch {}
                        const eff = getEffectiveOpencodeModel(this.settings || {}, projectPath);
                        this.send(ws, { event: "state_change", state: "idle" });
                        this.send(ws, { event: "llm_complete", text: `🤖 @opencode model: ${eff.model || "(opencode default)"} [${eff.source}]\n💡 Set it: @opencode-model <provider/model>` });
                        return;
                    }
                    this.settings.opencode_model = arg;
                    try { saveSettings(this.settings); } catch {}
                    this.send(ws, { event: "state_change", state: "idle" });
                    this.send(ws, { event: "llm_complete", text: `🤖 @opencode model set to "${arg}".` });
                    return;
                }
                if (cmdLower === "/opencode" || cmdLower.startsWith("/opencode ")) {
                    const taskText = cmdText.slice(9).trim();
                    if (!taskText) {
                        this.send(ws, { event: "state_change", state: "idle" });
                        this.send(ws, { event: "llm_complete", text: "⚠️ Usage: @opencode <project or coding task description>\nNeeds @set-project-path <dir> first; model via @opencode-model or opencode's own config." });
                        return;
                    }
                    this.send(ws, { event: "state_change", state: "thinking" });
                    try {
                        const res = await runOpencodeCommand(taskText, this.settings, {
                            senderId: "web",
                            onStart: async (info) => {
                                this.send(ws, { event: "llm_complete", text: info.startMessage || formatOpencodeStart(taskText, info) });
                                this.send(ws, { event: "state_change", state: "thinking" });
                            },
                        });
                        const reply = formatOpencodeFinish(taskText, res, res.elapsedMs ?? 0);
                        sessionMessages.push({ role: "user", content: trimmedText });
                        sessionMessages.push({ role: "assistant", content: reply });
                        saveSession(session.id, sessionMessages, activeChar.id);
                        this.send(ws, { event: "state_change", state: "idle" });
                        this.send(ws, { event: "llm_complete", text: reply });
                    } catch (err) {
                        this.send(ws, { event: "state_change", state: "idle" });
                        this.send(ws, { event: "llm_complete", text: `⚠️ @opencode error: ${err.message || err}` });
                    }
                    return;
                }
            }

            // Simulation mode: simple separate chat thread, same persona.
            {
                const simCmd = handleSimulationBridgeCommand(trimmedText, {
                    platform: "web",
                    characterId: activeChar.id,
                    personaName: activeChar.name,
                    chatId: String(chatId),
                });
                if (simCmd.handled) {
                    this.send(ws, { event: "state_change", state: "idle" });
                    this.send(ws, { event: "llm_complete", text: simCmd.reply });
                    return;
                }
            }

            this.send(ws, { event: "state_change", state: "thinking" });

            // Needle on-device fast-path: local-action turns skip the main
            // LLM; the reply is still spoken via TTS. Returns early so the
            // heuristic + LLM + background-learn flow below is skipped (the
            // executor already stored the canonical entries).
            try {
                const fastPath = await tryNeedleFastPath(trimmedText, {
                    settings: this.settings,
                    activeCharacterId: activeChar.id,
                });
                if (fastPath && fastPath.handled) {
                    if (this.checkAborted(ws, myTurn)) return;
                    sessionMessages.push({ role: "user", content: trimmedText });
                    sessionMessages.push({ role: "assistant", content: fastPath.reply });
                    saveSession(session.id, sessionMessages, activeChar.id);
                    this.send(ws, { event: "llm_complete", text: fastPath.reply });
                    await this.speakReply(ws, fastPath.reply, myTurn);
                    return;
                }
            } catch {}

            const learningPipeline = getLearningPipeline();
            const simAugWeb = getSimulationChatAugmentation(trimmedText, {
                platform: "web",
                characterId: activeChar.id,
                personaName: activeChar.name,
                chatId: String(chatId),
            });
            const simActiveWeb = simAugWeb.activeSim;
            if (!simActiveWeb) {
                learningPipeline.extractHeuristic(trimmedText, activeChar.id);
            }

            const modelMessages = [];
            const systemPromptText = composeSystemTemplate(activeChar);
            if (systemPromptText) {
                modelMessages.push({ role: "system", content: systemPromptText });
            }
            for (const block of simAugWeb.blocks.slice(0, simActiveWeb ? 1 : 0)) {
                modelMessages.push({ role: "system", content: block });
            }

            const relevantMemories = retrieveMemories(trimmedText, 5, undefined, activeChar.id);
            try {
                const { detectLanguage: _dl, buildLanguageScopeNote: _note } = await import("./language.js");
                const _det = _dl(trimmedText || "");
                if (_det.code && _det.code !== "und" && _det.code !== "shared") {
                    const _bridges = relevantMemories.filter((m) => typeof m === "string" && m.includes("[via ")).length;
                    const _scope = _note(_det.code, _bridges);
                    if (_scope) modelMessages.push({ role: "system", content: _scope });
                }
            } catch {}
            if (relevantMemories.length > 0) {
                modelMessages.push({
                    role: "system",
                    content: `[Relevant Persistent Memories]:\n${relevantMemories.map((m) => `• ${m}`).join("\n")}`,
                });
            }
            for (const block of simAugWeb.blocks.slice(simActiveWeb ? 1 : 0)) {
                modelMessages.push({ role: "system", content: block });
            }

            const relevantKnowledge = retrieveKnowledge(trimmedText, 4);
            if (relevantKnowledge.length > 0) {
                modelMessages.push({
                    role: "system",
                    content: `[Relevant Knowledge Base]:\n${relevantKnowledge.map((k) => `• [${k.knowledge.title} (${k.knowledge.category})]: ${k.knowledge.content}`).join("\n")}`,
                });
            }

            // Live web search ("@live-web" anywhere in the sentence).
            try {
                const { runWebSearchForPrompt } = await import("./websearch.js");
                const webHit = await runWebSearchForPrompt(trimmedText, this.settings);
                if (webHit.triggered && webHit.block) {
                    modelMessages.push({ role: "system", content: webHit.block });
                }
            } catch {}

            const historyWindow = simActiveWeb && simAugWeb.historyOverride
                ? simAugWeb.historyOverride.slice(-6)
                : sessionMessages.slice(-6);
            for (const h of historyWindow) {
                if (h.role === "user" || h.role === "assistant") {
                    modelMessages.push({ role: h.role, content: h.content });
                }
            }

            modelMessages.push({ role: "user", content: trimmedText });

            const llmRes = await this.services.unifiedChat({
                modelName: this.settings.model,
                messages: modelMessages,
                stream: false,
                settings: this.settings,
                ollamaClient: ollama,
            });

            if (this.checkAborted(ws, myTurn)) return;

            const replyText = cleanMarkdownToText(llmRes.content || "No response generated.");

            if (simActiveWeb) {
                try {
                    appendSimulationExchange(simActiveWeb.slug, trimmedText, replyText);
                    extractSimulationHeuristic(simActiveWeb.slug, trimmedText);
                } catch {}
            } else {
                sessionMessages.push({ role: "user", content: trimmedText });
                sessionMessages.push({ role: "assistant", content: replyText });
                saveSession(session.id, sessionMessages, activeChar.id);

                // Trigger background incremental learning extraction (scoped to active character)
                if (this.settings.auto_learning_enabled !== false) {
                    const historyContext = sessionMessages.slice(-6).map((m) => `${m.role}: ${m.content}`).join("\n");
                    learningPipeline.extractWithLLM(trimmedText, replyText, historyContext, {
                        settings: this.settings,
                        ollamaClient: ollama,
                        characterId: activeChar.id,
                    }).catch(() => {});
                }
            }

            this.send(ws, { event: "llm_complete", text: replyText });

            // TTS Speech Synthesis shares speakReply() (also used by the Needle fast-path above).
            await this.speakReply(ws, replyText, myTurn);
        } catch (err) {
            console.error("⚠️ Local Voice Socket text processing error:", err);
            // Never leave the webview stuck in "thinking": a superseded turn
            // stays silent (the newer turn owns the UI), any other failure
            // still delivers a visible error reply.
            if (this.turnAborted(ws, myTurn)) {
                if (ws && myTurn === (ws.turnSeq || 0)) {
                    this.send(ws, { event: "state_change", state: "idle" });
                }
                return;
            }
            this.send(ws, { event: "state_change", state: "idle" });
            this.send(ws, { event: "llm_complete", text: `⚠️ Error: ${err.message}` });
        }
    }

    start(port = PORT) {
        if (this.server) return;

        const htmlPath = path.join(process.cwd(), "voice_interface.html");

        try {
            this.server = Bun.serve({
                port,
                hostname: BIND_HOST,
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
                        this.send(ws, {
                            event: "connected",
                            message: "Connected to Local Dagowan Voice AI Bridge",
                            settings: this.settings,
                        });
                    },
                    message: (ws, message) => {
                        // Query turns run fire-and-forget: awaiting a slow LLM/TTS
                        // turn here would queue the user's interrupt + next prompt
                        // behind it, leaving the webview stuck with no response.
                        // Each turn carries its own abort guard (turnSeq), so
                        // concurrent turns are safe — only the latest answers.
                        const runTurn = (promise) => {
                            promise.catch((err) => {
                                console.error("WebSocket turn error:", err?.message || err);
                                // Backstop: process* methods already answer their own
                                // turn; only unstick the UI when the latest turn is
                                // still live (a superseded turn stays silent).
                                if (ws && (ws.cancelSeq || 0) < (ws.turnSeq || 0)) {
                                    try {
                                        this.send(ws, { event: "state_change", state: "idle" });
                                        this.send(ws, { event: "llm_complete", text: `⚠️ Error: ${err?.message || err}` });
                                    } catch {}
                                }
                            });
                        };
                        try {
                            const data = JSON.parse(message);
                            if (data.event === "audio_data" && data.audio) {
                                runTurn(this.processVoiceQuery(ws, data.audio, data.mimeType));
                            } else if (data.event === "text_prompt" && data.text) {
                                runTurn(this.processTextQuery(ws, data.text));
                            } else if (data.event === "update_settings" && data.settings) {
                                // The model is selected centrally through /model. Web voice settings
                                // may tune speech engines but cannot silently diverge from other tools.
                                // Security PIN + OTP keys are only managed via @set-security-pin / @otp-*,
                                // and no setting may change at all while the lock is engaged.
                                if (isSurfaceLocked(this.settings, WEB_SCOPE)) {
                                    this.send(ws, { event: "llm_complete", text: lockedMessage(this.settings, WEB_SCOPE) });
                                    return;
                                }
                                const { model: _ignoredModel, ...restSettings } = data.settings;
                                const voiceSettings = { ...restSettings };
                                for (const k of SECURITY_PIN_KEYS) delete voiceSettings[k];
                                for (const k of OTP_KEYS) delete voiceSettings[k];
                                if (voiceSettings.security_unlock_minutes !== undefined) {
                                    const m = Math.floor(Number(voiceSettings.security_unlock_minutes));
                                    voiceSettings.security_unlock_minutes = Number.isFinite(m)
                                        ? Math.min(Math.max(m, 1), 1440)
                                        : DEFAULT_UNLOCK_MINUTES;
                                }
                                this.settings = { ...this.settings, ...voiceSettings };
                                saveSettings(this.settings);
                                console.log("⚙️ [Voice Socket]: Settings updated via Web GUI.", {
                                    stt_engine: this.settings.stt_engine,
                                    tts_engine: this.settings.tts_engine,
                                    openai_tts_voice: this.settings.openai_tts_voice,
                                    has_openai_key: !!this.settings.openai_api_key,
                                });
                                this.send(ws, { event: "settings_updated", settings: this.settings });
                            } else if (data.event === "interrupt") {
                                this.interruptTurn(ws);
                                console.log("⏸ [Voice Socket]: Speech output interrupted by user for next prompt.");
                                this.send(ws, { event: "state_change", state: "idle" });
                            }
                        } catch (err) {
                            console.error("WebSocket message error:", err.message);
                        }
                    },
                    close: (ws) => {
                        this.interruptTurn(ws);
                        this.activeWs.delete(ws);
                        console.log("🎙 WebSocket Voice Client disconnected.");
                    },
                },
            });

            console.log("=========================================================================");
            console.log(`🌐 Dagowan Full-Duplex Voice Web View: http://127.0.0.1:${port}`);
            console.log(`🎙 WebSocket Voice Server listening on ws://127.0.0.1:${port}/ws`);
            console.log("=========================================================================");
        } catch (err) {
            console.error("⚠️ Failed to start Local Voice Socket Bridge:", err.message);
        }
    }

    stop() {
        if (this.server) {
            this.server.stop();
            this.server = null;
            console.log("🛑 Local Voice Socket Bridge stopped.");
        }
    }
}
