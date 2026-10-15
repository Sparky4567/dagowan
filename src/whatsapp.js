import { logPrompt } from "./logger.js";
import http from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import ollama from "ollama";
import { unifiedChat } from "./providers.js";
import { tryNeedleFastPath } from "./needle.js";
import { transcribeAudioLocal, synthesizeSpeechLocal } from "./audio.js";

import { loadMemories, remember, retrieveMemories } from "./memory.js";
import { retrieveKnowledge } from "./knowledge.js";
import { getLearningPipeline } from "./learning.js";
import {
    registerTask,
    formatActiveTasks,
    moveTask,
    deleteTask,
    parseMoveTaskCommand,
    parseDeleteTaskCommand,
} from "./tasks.js";
import { getActiveCharacter, composeSystemTemplate, findCharacterByName } from "./characters.js";
import { findMentionedCharacters, stripCharacterMentions, isGroupJid } from "./whatsapp_mentions.js";
import { remoteSession, saveSession } from "./sessions.js";
import { retrieveNotesChunks, writeAboutPrompt } from "./workspace.js";
import { convertNotesToPdf, convertPdfToMd } from "./pdf_utils.js";
import { exportSettings, importSettings, saveSettings } from "./config.js";
import { AgenticModule } from "./agentic.js";
import { buildCommandsHelp } from "./commands.js";
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
import { handleProactiveCommand } from "./proactive.js";
import { runMakeCommand, runCreateFileCommand } from "./ollama_coding.js";
import { runOpenCliCommand, checkOpenCliAccess, truncateForChat } from "./opencli.js";
import { runOpencodeCommand, checkOpencodeAccess, getEffectiveOpencodeModel, requireExplicitProjectPath, truncateForChat as truncateOpencodeForChat, runOpencodeSetupStep, formatOpencodeStart, formatOpencodeFinish } from "./opencode.js";
import {
    addSimulationMemory,
    appendSimulationExchange,
    extractSimulationHeuristic,
    getActiveSimulation,
    getSimulationChatAugmentation,
    handleSimulationBridgeCommand,
    scopeKeyFor,
} from "./simulation.js";
import { parseCastInput, runCastCommand } from "./cast/caster.js";
import {
    isOtpCommand,
    isProbablyControlCommand,
    isSurfaceLocked,
    lockedMessage,
    runOtpCommand,
    runSecurityCommand,
    whatsappScope,
} from "./security.js";

const DEFAULT_PORT = Number(process.env.WHATSAPP_PORT || 8765);
const DEFAULT_STATUS_PORT = Number(process.env.WHATSAPP_STATUS_PORT || 8766);
const BIND_HOST = process.env.BIND_HOST || process.env.HOST || "0.0.0.0";

// WhatsApp bridge is OPT-IN and disabled by default. It must never start
// spraying QR codes when it was never configured: implicit autostart via
// `settings.whatsapp_enabled` requires a phone number or an existing auth
// session (whatsapp_bridge/auth/creds.json). An explicit `--whatsapp` CLI
// flag still starts the bridge on demand (user asked for it).
export function isTermuxEnvironment(env = process.env) {
    if (env.TERMUX_VERSION) return true;
    const prefix = String(env.PREFIX || "");
    if (prefix.includes("com.termux")) return true;
    const termuxKeys = Object.keys(env || {}).filter((k) => k.startsWith("TERMUX_"));
    if (termuxKeys.length > 0) return true;
    return false;
}

export function getWhatsAppQrMode(env = process.env) {
    const raw = String(env.WHATSAPP_QR_MODE || env.WHATSAPP_QR || "auto").toLowerCase().trim();
    if (["off", "disable", "disabled", "none", "0", "false"].includes(raw)) return "off";
    if (["pairing", "pair", "numeric", "number", "code"].includes(raw)) return "pairing";
    if (["qr", "qrcode", "scan"].includes(raw)) return "qr";
    return "auto";
}

export function hasWhatsAppAuth(cwd = process.cwd()) {
    try {
        const creds = path.join(cwd, "whatsapp_bridge", "auth", "creds.json");
        return fs.existsSync(creds);
    } catch {
        return false;
    }
}

export function isWhatsAppConfigured(settings = null, env = process.env, cwd = process.cwd()) {
    const phone = String((settings && settings.whatsapp_phone) || env.WHATSAPP_PHONE || "").replace(/[^0-9]/g, "");
    if (phone.length >= 7) return true;
    try {
        if (hasWhatsAppAuth(cwd)) return true;
    } catch {}
    return false;
}

function parseEnabledFlag(value) {
    if (value === undefined || value === null) return null;
    const v = String(value).toLowerCase().trim();
    if (["1", "true", "on", "enable", "enabled", "yes"].includes(v)) return true;
    if (["0", "false", "off", "disable", "disabled", "no"].includes(v)) return false;
    return null;
}

// Central gate used by the CLI: returns { start, reason }.
export function shouldStartWhatsApp(settings = null, argv = process.argv, env = process.env, cwd = process.cwd()) {
    const args = Array.isArray(argv) ? argv : [];
    const explicitOn = args.includes("--whatsapp");
    const explicitOff = args.includes("--no-whatsapp") || args.includes("--no-whatsapp-bridge");
    if (explicitOff) return { start: false, reason: "disabled-flag" };
    // Env override wins over stored settings (needed for Docker/Termux).
    const envFlag = parseEnabledFlag(env.WHATSAPP_ENABLED);
    if (envFlag === false && !explicitOn) return { start: false, reason: "disabled-env" };
    if (explicitOn || envFlag === true) return { start: true, reason: explicitOn ? "flag" : "env" };
    if (settings && settings.whatsapp_enabled) {
        if (isWhatsAppConfigured(settings, env, cwd)) return { start: true, reason: "settings" };
        return { start: false, reason: "not-configured" };
    }
    return { start: false, reason: "disabled-default" };
}

function mentionGateEnabled(settings) {
    if (settings && settings.whatsapp_mention_only_groups === false) return false;
    const env = process.env.WHATSAPP_MENTION_ONLY_GROUPS;
    if (env === "0" || (env && env.toLowerCase() === "false")) return false;
    return true;
}

function mentionStripEnabled(settings) {
    if (settings && settings.whatsapp_strip_mention === false) return false;
    const env = process.env.WHATSAPP_STRIP_MENTION;
    if (env === "0" || (env && env.toLowerCase() === "false")) return false;
    return true;
}

function mentionPrefixEnabled(settings) {
    if (settings && settings.whatsapp_mention_prefix === false) return false;
    const env = process.env.WHATSAPP_MENTION_PREFIX;
    if (env === "0" || (env && env.toLowerCase() === "false")) return false;
    return true;
}

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
    const statusPort = Number(process.env.WHATSAPP_STATUS_PORT || 8766);
    const digits = String(phone || "").replace(/[^0-9]/g, "");
    if (!digits || digits.length < 7) {
        return { success: false, error: "phone number with country code is required (e.g. @whatsapp-pair 37060000000)" };
    }
    try {
        const res = await fetch(`http://127.0.0.1:${statusPort}/pair`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ phone: digits }),
        });
        let data = {};
        try {
            data = await res.json();
        } catch {
            return { success: false, error: `bridge returned HTTP ${res.status} (is the WhatsApp bridge running? start with --whatsapp)` };
        }
        if (res.ok && data.ok && data.pairingCode) {
            return { success: true, pairingCode: data.pairingCode };
        } else {
            return { success: false, error: data.error || `bridge returned HTTP ${res.status}` };
        }
    } catch (err) {
        return { success: false, error: `${err.message} (is the WhatsApp bridge running? start with --whatsapp)` };
    }
}

export class WhatsAppNodeBridgeProcess {
    constructor(settings = null) {
        this.settings = settings;
        this.process = null;
        // Auto-restart state: the Baileys socket process must not silently
        // stay dead after a crash — that looks like "WhatsApp stopped working".
        this.wantRunning = false;
        this.restartAttempts = 0;
        this.restartTimer = null;
    }

    start() {
        if (this.process) return;
        this.wantRunning = true;
        this.restartAttempts = 0;
        this.launch();
    }

    launch() {
        if (this.process || !this.wantRunning) return;

        const bridgeDir = path.join(process.cwd(), "whatsapp_bridge");
        const entrypoint = path.join(bridgeDir, "index.js");

        if (!fs.existsSync(entrypoint)) {
            console.error("⚠️ whatsapp_bridge/index.js missing.");
            return;
        }

        const phone = (this.settings && this.settings.whatsapp_phone) || process.env.WHATSAPP_PHONE || "";
        const qrMode = getWhatsAppQrMode(process.env);
        const termux = isTermuxEnvironment(process.env);

        try {
            this.process = spawn("node", [entrypoint], {
                cwd: bridgeDir,
                env: {
                    ...process.env,
                    JARVIS_CHAT_URL: `http://127.0.0.1:${DEFAULT_PORT}/chat`,
                    WHATSAPP_STATUS_PORT: String(DEFAULT_STATUS_PORT),
                    WHATSAPP_PHONE: phone,
                    WHATSAPP_QR_MODE: qrMode,
                },
                stdio: "inherit",
            });

            console.log("📱 WhatsApp Node Baileys bridge socket process started.");
            if (phone) {
                console.log(`📱 Default WhatsApp Phone number set: +${phone.replace(/[^0-9]/g, "")}`);
            }
            if (qrMode === "off") {
                console.log("📱 QR/pairing output disabled (WHATSAPP_QR_MODE=off). Use @whatsapp-pair <phone> to link.");
            } else if (qrMode === "pairing" || (qrMode === "auto" && termux)) {
                console.log("📱 Termux/pairing mode: use the 8-digit numeric pairing code (no camera scan needed).");
                console.log("   Link with: @whatsapp-pair <phone_number_with_country_code> or POST /pair {\"phone\": \"...\"}");
            }
            console.log("=========================================================================");
            console.log("📱 QR Code / Pairing Web View: http://127.0.0.1:8766/qr");
            console.log(`📁 Local HTML file: file://${path.join(process.cwd(), "whatsapp_qr.html")}`);
            console.log("=========================================================================");

            this.process.on("error", (err) => {
                console.error("📱 WhatsApp node bridge process error:", err.message);
            });

            this.process.on("exit", (code, signal) => {
                this.process = null;
                if (code !== 0 && code !== null) {
                    console.log(`📱 WhatsApp node bridge process exited with code ${code}.`);
                }
                // Crash/auto-restart with backoff (stop() sets wantRunning=false).
                if (this.wantRunning) {
                    this.restartAttempts += 1;
                    const delayMs = Math.min(5000 * this.restartAttempts, 60000);
                    console.log(`📱 WhatsApp node bridge restarting in ${Math.round(delayMs / 1000)}s (attempt ${this.restartAttempts})...`);
                    if (this.restartTimer) clearTimeout(this.restartTimer);
                    this.restartTimer = setTimeout(() => {
                        this.restartTimer = null;
                        this.launch();
                    }, delayMs);
                    if (typeof this.restartTimer.unref === "function") this.restartTimer.unref();
                }
            });
        } catch (err) {
            console.error("📱 Failed to launch WhatsApp node bridge:", err.message);
        }
    }

    stop() {
        this.wantRunning = false;
        if (this.restartTimer) {
            clearTimeout(this.restartTimer);
            this.restartTimer = null;
        }
        if (this.process) {
            const proc = this.process;
            try {
                proc.kill("SIGTERM");
            } catch {}
            // Escalate: never leave a half-dead socket process behind to
            // compete with the next launch (duplicate-connection flapping).
            setTimeout(() => {
                try {
                    if (this.process === proc) proc.kill("SIGKILL");
                } catch {}
            }, 5000);
            this.process = null;
            console.log("📱 WhatsApp node bridge process stopped.");
        }
    }
}

export class WhatsAppBridgeServer {
    constructor({ port = DEFAULT_PORT, statusPort = DEFAULT_STATUS_PORT, characterStore, settings, proactiveManager = null, personaBridge = null }) {
        this.port = port;
        this.statusPort = statusPort;
        this.characterStore = characterStore;
        this.settings = settings;
        this.proactiveManager = proactiveManager;
        this.personaBridge = personaBridge;
        // Per-chat promise chains: concurrent /chat POSTs for the same JID
        // must not run the LLM + session read-modify-write concurrently
        // (out-of-order replies, lost history via last-writer-wins saves).
        this.chatQueues = new Map();
        this.server = null;
        this.nodeProcess = new WhatsAppNodeBridgeProcess(settings);
        this.agentic = new AgenticModule();
    }

    setPersonaBridge(bridge) {
        this.personaBridge = bridge || null;
    }

    touchPersona(characterId) {
        try {
            if (this.personaBridge && characterId) {
                if (!this.personaBridge.recordActivity(characterId)) {
                    void this.personaBridge.ensurePersona(characterId, "whatsapp-activity").catch(() => {});
                }
            }
        } catch {}
    }

    async processPrompt(promptText, chatId, opts = {}) {
        if (!promptText || !promptText.trim()) {
            return "No input provided.";
        }

        logPrompt(promptText, "whatsapp");

        if (this.proactiveManager) {
            this.proactiveManager.recordActivity(`wa_${chatId}`);
        }

        const activeChar = getActiveCharacter(this.characterStore);
        // Canonical "@" commands (MCP-style); "/" still accepted.
        // "@" and "/" are both 1 char so all slice offsets below work for either prefix.
        const trimmedPrompt = promptText.trim();
        const cmdText = trimmedPrompt.startsWith("@") ? "/" + trimmedPrompt.slice(1) : trimmedPrompt;
        const lower = cmdText.toLowerCase();

        // Security PIN + OTP: @set-security-pin / @unlock / @lock /
        // @security-status / @remove-security-pin and @otp-* work while locked;
        // every other control-shaped message needs @otp-login (+ @unlock when
        // a PIN is set) first. Regular chatting passes.
        const waScope = whatsappScope(chatId);
        const waSec = runSecurityCommand(trimmedPrompt, this.settings, waScope);
        if (waSec.handled) {
            if (waSec.settingsChanged) {
                try { saveSettings(this.settings); } catch {}
            }
            return waSec.reply;
        }
        const waOtp = runOtpCommand(trimmedPrompt, this.settings, waScope);
        if (waOtp.handled) {
            if (waOtp.settingsChanged) {
                try { saveSettings(this.settings); } catch {}
            }
            return waOtp.reply;
        }
        const waLocked = isSurfaceLocked(this.settings, waScope);
        if (waLocked && !isOtpCommand(lower)) {
            const waChars = (this.characterStore && this.characterStore.characters) || [];
            if (isProbablyControlCommand(trimmedPrompt, waChars) || detectBlogIntent(trimmedPrompt)) {
                return lockedMessage(this.settings, waScope);
            }
        }

        // Proactive Chat Commands
        const proactiveRes = handleProactiveCommand(promptText, this.settings, this.proactiveManager);
        if (proactiveRes.handled) {
            return proactiveRes.output;
        }

        // Simulation mode: simple separate chat thread, same persona.
        {
            const simCmd = handleSimulationBridgeCommand(trimmedPrompt, {
                platform: "whatsapp",
                characterId: activeChar.id,
                personaName: activeChar.name,
                chatId: String(chatId),
            });
            if (simCmd.handled) return simCmd.reply;
        }

        // Daily self-reflections (@insight family; lock-gated above).
        {
            try {
                const { parseInsightCommand, handleReflectionBridgeCommand } = await import("./reflections.js");
                if (parseInsightCommand(trimmedPrompt)) {
                    const { Ollama } = await import("ollama");
                    let waOllama = null;
                    try { waOllama = new Ollama({ host: this.settings.server_url }); } catch {}
                    const res = await handleReflectionBridgeCommand(trimmedPrompt, {
                        characterId: activeChar.id,
                        personaName: activeChar.name,
                        settings: this.settings,
                        ollamaClient: waOllama,
                    });
                    if (res.handled) return res.reply;
                }
            } catch {}
        }

        // Persona polling bridge commands (on-demand Telegram polling)
        if (lower === "/polling-status" || lower === "/polling" || lower === "/pollers") {
            const bridge = this.personaBridge;
            return bridge && typeof bridge.formatStatus === "function" ? bridge.formatStatus() : "🔌 Persona polling bridge not initialized.";
        }
        if (lower === "/wake" || lower.startsWith("/wake ")) {
            const target = promptText.slice(5).trim();
            if (!target) return "⚠️ Usage: @wake <character name|id>";
            const bridge = this.personaBridge;
            if (!bridge || typeof bridge.ensurePersona !== "function") return "⚠️ Persona polling bridge not initialized.";
            const res = await bridge.ensurePersona(target, "whatsapp-wake");
            return res && res.runner
                ? (res.started ? `🔌 Polling started for "${res.character?.name || target}".` : `🔌 "${res.character?.name || target}" is already polling.`)
                : `⚠️ Cannot wake "${target}": ${res?.reason || "no Telegram token"}.`;
        }
        if (lower === "/sleep" || lower.startsWith("/sleep ")) {
            const target = promptText.slice(6).trim();
            if (!target) return "⚠️ Usage: @sleep <character name|id>";
            const bridge = this.personaBridge;
            if (!bridge || typeof bridge.sleepPersona !== "function") return "⚠️ Persona polling bridge not initialized.";
            const res = await bridge.sleepPersona(target);
            return res.success ? `🔌 ${res.message}` : `⚠️ ${res.message}`;
        }

        // Commands handling
        if (lower === "/help" || lower === "/commands" || lower === "/get-commands") {
            return buildCommandsHelp(this.settings);
        }

        // Ollama CLI @make
        if (lower.startsWith("/make") || lower === "/make") {
            const taskPrompt = promptText.slice(5).trim();
            if (!taskPrompt) {
                return "⚠️ Usage: @make <project description>\nExample: @make Create a python script in server.py";
            }
            const res = await runMakeCommand(taskPrompt, this.settings);
            return res.output || "🔨 Project task completed!";
        }

        // Ollama CLI @create-file
        if (lower.startsWith("/create-file") || lower === "/create-file") {
            const payload = promptText.slice(12).trim();
            if (!payload) {
                return "⚠️ Usage: @create-file <file_path> [content|prompt]";
            }
            const firstSpaceIdx = payload.search(/\s/);
            let filePath = payload;
            let contentOrPrompt = "";
            if (firstSpaceIdx !== -1) {
                filePath = payload.slice(0, firstSpaceIdx).trim();
                contentOrPrompt = payload.slice(firstSpaceIdx + 1).trim();
            }
            const res = await runCreateFileCommand(filePath, contentOrPrompt, this.settings);
            return res.success ? `📄 ${res.output}` : `⚠️ ${res.error}`;
        }

        // OpenCLI @opencli (owner-gated on WhatsApp; placed before the
        // group mention gate so allowed chats can use it in groups too)
        if (lower === "/opencli" || lower.startsWith("/opencli ")) {
            const taskText = promptText.slice(8).trim();
            if (!taskText) {
                return "⚠️ Usage: @opencli <project or coding task description>\nExample: @opencli Scaffold a bun + sqlite todo API in ./todo-api with tests";
            }
            const senderId = (opts && (opts.remoteJid || opts.remotejid)) || String(chatId || "");
            const gate = checkOpenCliAccess(this.settings, senderId);
            if (!gate.allowed) return gate.reason;
            const res = await runOpenCliCommand(taskText, this.settings, { senderId });
            return res.success ? `🤖 ${truncateForChat(res.output)}` : `⚠️ ${res.error}`;
        }

        // opencode CLI auto-allow alias - @opencode-setup-auto-allow [mode] (owner-gated on WhatsApp)
        if (lower === "/opencode-setup-auto-allow" || lower.startsWith("/opencode-setup-auto-allow ")) {
            const senderId = (opts && (opts.remoteJid || opts.remotejid)) || String(chatId || "");
            const gate = checkOpencodeAccess(this.settings, senderId);
            if (!gate.allowed) return gate.reason;
            const modeArgs = promptText.slice(26).trim();
            try {
                const res = await runOpencodeSetupStep(`auto-allow ${modeArgs}`.trim(), this.settings, { senderId });
                if (res.settingsChanged) {
                    try { saveSettings(this.settings); } catch {}
                }
                return truncateOpencodeForChat(res.reply);
            } catch (err) {
                return `⚠️ @opencode-setup-auto-allow error: ${err.message || err}`;
            }
        }

        // opencode CLI guided setup - @opencode-setup [...] (owner-gated on WhatsApp)
        if (lower === "/opencode-setup" || lower.startsWith("/opencode-setup ")) {
            const senderId = (opts && (opts.remoteJid || opts.remotejid)) || String(chatId || "");
            const gate = checkOpencodeAccess(this.settings, senderId);
            if (!gate.allowed) return gate.reason;
            const stepArgs = promptText.slice(15).trim();
            try {
                const res = await runOpencodeSetupStep(stepArgs, this.settings, { senderId });
                if (res.settingsChanged) {
                    try { saveSettings(this.settings); } catch {}
                }
                return truncateOpencodeForChat(res.reply);
            } catch (err) {
                return `⚠️ @opencode-setup error: ${err.message || err}`;
            }
        }

        // opencode CLI model - @opencode-model [<model>]
        if (lower === "/opencode-model" || lower.startsWith("/opencode-model ")) {
            const senderId = (opts && (opts.remoteJid || opts.remotejid)) || String(chatId || "");
            const gate = checkOpencodeAccess(this.settings, senderId);
            if (!gate.allowed) return gate.reason;
            const arg = promptText.slice(15).trim();
            if (!arg) {
                let projectPath = null;
                try {
                    projectPath = requireExplicitProjectPath(this.settings);
                } catch {}
                const eff = getEffectiveOpencodeModel(this.settings || {}, projectPath);
                return `🤖 @opencode model: ${eff.model || "(opencode default)"} [${eff.source}]\n💡 Set it: @opencode-model <provider/model>`;
            }
            this.settings.opencode_model = arg;
            try { saveSettings(this.settings); } catch {}
            return `🤖 @opencode model set to "${arg}".`;
        }

        // opencode CLI @opencode (owner-gated on WhatsApp)
        // NOTE: /chat is single-reply request/response, so the bridge cannot
        // push a separate "RUNNING" message mid-turn. We log the start
        // server-side and return a FINISHED message with task + timing.
        if (lower === "/opencode" || lower.startsWith("/opencode ")) {
            const taskText = promptText.slice(9).trim();
            if (!taskText) {
                return "⚠️ Usage: @opencode <project or coding task description>\nNeeds @set-project-path <dir> first; model via @opencode-model or opencode's own config.";
            }
            const senderId = (opts && (opts.remoteJid || opts.remotejid)) || String(chatId || "");
            const gate = checkOpencodeAccess(this.settings, senderId);
            if (!gate.allowed) return gate.reason;
            try {
                const pp = requireExplicitProjectPath(this.settings);
                console.log(formatOpencodeStart(taskText, { projectPath: pp }));
            } catch {}
            const res = await runOpencodeCommand(taskText, this.settings, { senderId });
            return truncateOpencodeForChat(formatOpencodeFinish(taskText, res, res.elapsedMs ?? 0));
        }

        // @youtube-play / @play (API-first, Chromium fallback).
        // Placed before the group mention gate so @play works in groups too.
        if (lower.startsWith("/youtube-play") || lower === "/play" || lower.startsWith("/play ")) {
            const parsed = parsePlayInput(cmdText);
            if (!parsed || !parsed.query) {
                return "⚠️ Usage: @youtube-play <search terms or YouTube URL> [--no-show]";
            }
            const res = await playYoutubeViaApi(parsed.query, this.settings, { show: parsed.show });
            return formatPlayResult(res);
        }

        if (lower.startsWith("/spotify-play") || lower === "/spotify" || lower.startsWith("/spotify ")) {
            const parsed = parseSpotifyPlayInput(cmdText);
            if (!parsed || !parsed.query) {
                return "⚠️ Usage: @spotify-play <search terms or Spotify URL> [--no-show]";
            }
            const res = await playSpotifyViaApi(parsed.query, this.settings, { show: parsed.show });
            return formatSpotifyPlayResult(res);
        }

        // Blog drafts - @blog / @wordpress / @blogger / @post (API-first,
        // Chromium editor fallback). Placed before the group mention gate
        // so @blog works in groups too, like @play.
        const blogParsed = parseBlogInput(cmdText);
        if (blogParsed) {
            if (!blogParsed.topic) {
                return "⚠️ Usage: @blog <topic> [--on wordpress|blogger] [--title <title>] [--no-show]";
            }
            const mentionedForBlog = findMentionedCharacters(trimmedPrompt, (this.characterStore && this.characterStore.characters) || []);
            const voiceCharForBlog = mentionedForBlog[0] || activeChar;
            const res = await draftBlogViaApi(blogParsed.topic, this.settings, { platform: blogParsed.platform, title: blogParsed.title, show: blogParsed.show, settings: this.settings, ollamaClient: ollama || null, characterPersona: composeSystemTemplate(voiceCharForBlog), characterName: voiceCharForBlog.name });
            return formatBlogDraftResult(res);
        }
        // Natural "@Parsly, write a blog post about ... on @wordpress/@blogger"
        // callouts (also before the mention gate so group callouts resolve).
        const blogIntent = detectBlogIntent(trimmedPrompt);
        if (blogIntent) {
            const byName = blogIntent.mentionedCharacter ? findCharacterByName(this.characterStore, blogIntent.mentionedCharacter) : null;
            const mentionedForIntent = (!byName && trimmedPrompt.includes("@"))
                ? findMentionedCharacters(trimmedPrompt, (this.characterStore && this.characterStore.characters) || [])
                : [];
            const voiceCharForIntent = byName || mentionedForIntent[0] || activeChar;
            const res = await draftBlogViaApi(blogIntent.topic, this.settings, { platform: blogIntent.platform, show: true, settings: this.settings, ollamaClient: ollama || null, characterPersona: composeSystemTemplate(voiceCharForIntent), characterName: voiceCharForIntent.name });
            return formatBlogDraftResult(res);
        }

        // Fact-check - @fact-check / @factcheck / @verify (Semantic Scholar papers + optional Gemini verdict).
        // Placed before the group mention gate so @fact-check works in
        // groups too, like @play/@blog.
        const factParsed = parseFactCheckInput(cmdText, this.settings);
        if (factParsed) {
            if (!factParsed.claim) {
                return "⚠️ Usage: @fact-check <claim> [--limit N] [--source auto|papers|gemini]";
            }
            const res = await checkFactClaimViaApi(factParsed.claim, this.settings, { maxResults: factParsed.maxResults, source: factParsed.source, model: factParsed.model, verdict: factParsed.verdict });
            return formatFactCheckResult(res);
        }

        // Live web search - @live-web / @web-search / @websearch / @web-fetch / @web-status
        // (inline "@live-web within a sentence" is injected into LLM context below).
        {
            const { parseWebSearchCommand, parseWebFetchCommand, parseWebStatusCommand, searchWeb, formatWebResults, fetchPageText, formatPageText, formatWebStatus } = await import("./websearch.js");
            if (parseWebStatusCommand(promptText)) return formatWebStatus(this.settings);
            const webSearchCmd = parseWebSearchCommand(promptText, this.settings);
            if (webSearchCmd) {
                if (!webSearchCmd.query) return '⚠️ Usage: @web-search <query> [--provider auto|duckduckgo|brave|tavily] [--limit N]\nInline form: mention @live-web anywhere in a sentence ("latest BTC price @live-web")';
                const res = await searchWeb(webSearchCmd.query, this.settings, { provider: webSearchCmd.provider, maxResults: webSearchCmd.maxResults });
                return formatWebResults(res);
            }
            const webFetchCmd = parseWebFetchCommand(promptText);
            if (webFetchCmd) {
                if (!webFetchCmd.url) return "⚠️ Usage: @web-fetch <url>";
                const res = await fetchPageText(webFetchCmd.url, this.settings);
                return formatPageText(res);
            }
        }

        if (lower.startsWith("/browser-search-spotify ")) {
            const query = cmdText.slice("/browser-search-spotify".length).trim();
            if (!query) return "⚠️ Usage: @browser-search-spotify <query>";
            const res = await browserSearchSpotify(query, this.settings);
            if (!res.success || !res.results || res.results.length === 0) {
                return `⚠️ No results: ${(res && res.error) || "empty result set"}`;
            }
            return `🎧 Top Spotify results for "${query}":\n` +
                res.results.slice(0, 3).map((r, i) => `${i + 1}. ${r.title} [${r.kind || "track"}]\n   ${r.url}`).join("\n");
        }

        if (lower.startsWith("/browser-search ")) {
            const query = cmdText.slice("/browser-search".length).trim();
            if (!query) return "⚠️ Usage: @browser-search <query>";
            const res = await browserSearchYoutube(query, this.settings);
            if (!res.success || !res.results || res.results.length === 0) {
                return `⚠️ No results: ${(res && res.error) || "empty result set"}`;
            }
            return `🌐 Top YouTube results for "${query}":\n` +
                res.results.slice(0, 3).map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}`).join("\n");
        }

        if (lower.startsWith("/browser-open ")) {
            const url = cmdText.slice("/browser-open".length).trim();
            if (!url) return "⚠️ Usage: @browser-open <url>";
            const res = await browserOpen(url, this.settings);
            return res.success ? `🌐 Browser at: "${res.title || "(untitled)"}"\n🔗 ${res.url}` : `⚠️ ${res.error}`;
        }

        if (lower === "/browser-read") {
            const res = await browserRead(this.settings);
            if (!res.success) return `⚠️ ${res.error}`;
            return `🌐 [${res.title || res.url}]\n${(res.text || "").slice(0, 1500)}`;
        }

        if (lower === "/browser-shot" || lower.startsWith("/browser-shot ")) {
            const res = await browserScreenshot(cmdText.slice("/browser-shot".length).trim(), this.settings);
            return res.success ? `📸 Screenshot saved: ${res.path}` : `⚠️ ${res.error}`;
        }

        if (lower === "/browser-status") {
            const st = await browserStatus(this.settings);
            return `🌐 Browser: ${st.launched ? "running" : "stopped"} (${st.headless ? "headless fallback" : "visible window"})` +
                (st.url ? `\n🔗 ${st.title || ""} ${st.url}` : "");
        }

        if (lower === "/browser-close") {
            await browserClose();
            return "🌐 Local browser closed.";
        }

        // TV cast (Castor-style DLNA, shared parser with CLI/Telegram).
        {
            const castParsed = parseCastInput(cmdText);
            if (castParsed) {
                try {
                    const res = await runCastCommand(cmdText, this.settings);
                    if (res.settingsChanged) saveSettings(this.settings);
                    return res.reply;
                } catch (err) {
                    return `⚠️ Cast error: ${err.message || err}`;
                }
            }
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

        if (lower === "/ephemeral" || lower.startsWith("/ephemeral ") || lower === "/one-shot" || lower.startsWith("/one-shot ") || lower === "/oneshot" || lower.startsWith("/oneshot ")) {
            const { parseEphemeralToggleArg, formatEphemeralReply } = await import("./ollama_ephemeral.js");
            const parts = promptText.split(/\s+/);
            const action = parseEphemeralToggleArg(parts[1] || "");
            if (action === "invalid") return "⚠️ Usage: @ephemeral [on|off|status] (or @one-shot)";
            if (action === "on") this.settings.ollama_ephemeral = true;
            else if (action === "off") this.settings.ollama_ephemeral = false;
            try { saveSettings(this.settings); } catch {}
            return formatEphemeralReply(this.settings);
        }

        if (lower.startsWith("/convert-pdf") || lower.startsWith("/pdf")) {
            const parts = promptText.split(/\s+/);
            const res = convertNotesToPdf("notes", "pdfs", parts[1] || "", parts[2] || "");
            return res.success ? `📄 ${res.output}` : `⚠️ ${res.error}`;
        }

        if (lower.startsWith("/pdf-to-md") || lower.startsWith("/convert-md")) {
            const parts = promptText.split(/\s+/);
            const pdfFile = parts[1] || "";
            if (!pdfFile) return "⚠️ Usage: @pdf-to-md <filename.pdf>";
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
            const simScopeWa = scopeKeyFor("whatsapp", activeChar.id, String(chatId));
            const simActiveWa = getActiveSimulation(simScopeWa);
            if (simActiveWa) {
                addSimulationMemory(simActiveWa.slug, { type: "fact", content: text, source: "user_remember_simulation", confidence: 1.0, importance: 0.8 });
                return `🎭🧠 Simulation memory saved inside "${simActiveWa.name}": "${text}"`;
            }
            remember(text, undefined, activeChar.id);
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

        // Group @character-name callout gate (WhatsApp bridge only).
        // In group chats each persona responds only when explicitly mentioned
        // (e.g. "@Parsly ..."). Explicit "@" bot commands above already
        // returned, so they always bypass this gate. DMs skip this gate and
        // are handled by the DM mention router below.
        const remoteJidForGate = (opts && (opts.remoteJid || opts.remotejid)) || String(chatId || "");
        const groupFlag = opts && typeof opts.isGroup === "boolean" ? opts.isGroup : isGroupJid(remoteJidForGate);
        if (groupFlag && mentionGateEnabled(this.settings)) {
            const mentioned = findMentionedCharacters(promptText, (this.characterStore && this.characterStore.characters) || []);
            if (mentioned.length === 0) {
                return null;
            }
            let mentionQuery = mentionStripEnabled(this.settings)
                ? stripCharacterMentions(promptText, mentioned)
                : promptText.trim();
            if (!mentionQuery) {
                mentionQuery = promptText.trim();
            }
            const parts = [];
            for (const character of mentioned) {
                this.touchPersona(character.id);
                const reply = await this.runCharacterPrompt(promptText, mentionQuery, chatId, character);
                if (reply) {
                    parts.push(mentionPrefixEnabled(this.settings) ? `🎭 *${character.name}*:\n${reply}` : reply);
                }
            }
            if (parts.length === 0) {
                return null;
            }
            return parts.join("\n\n");
        }

        // 1:1 DM @character-name callouts: route to the mentioned persona(s)
        // instead of always answering as the active character. A DM with no
        // mention falls through to the active character below.
        const dmMentioned = findMentionedCharacters(promptText, (this.characterStore && this.characterStore.characters) || []);
        if (dmMentioned.length > 0) {
            let dmQuery = mentionStripEnabled(this.settings)
                ? stripCharacterMentions(promptText, dmMentioned)
                : promptText.trim();
            if (!dmQuery) {
                dmQuery = promptText.trim();
            }
            if (dmMentioned.length === 1) {
                this.touchPersona(dmMentioned[0].id);
                return await this.runCharacterPrompt(promptText, dmQuery, chatId, dmMentioned[0]);
            }
            const dmParts = [];
            for (const character of dmMentioned) {
                this.touchPersona(character.id);
                const reply = await this.runCharacterPrompt(promptText, dmQuery, chatId, character);
                if (reply) {
                    dmParts.push(mentionPrefixEnabled(this.settings) ? `🎭 *${character.name}*:\n${reply}` : reply);
                }
            }
            if (dmParts.length > 0) {
                return dmParts.join("\n\n");
            }
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

        return await this.runCharacterPrompt(promptText, queryText, chatId, activeChar);
    }

    /**
     * Run the full LLM pipeline (memory/knowledge/notes/history + chat +
     * session save + background learning) for one character persona.
     * `promptText` is the raw message stored in history; `queryText` is the
     * effective query sent to the model (mentions stripped in group mode).
     */
    async runCharacterPrompt(promptText, queryText, chatId, character) {
        this.touchPersona(character?.id);
        const session = remoteSession("whatsapp", String(chatId), character.id);
        const sessionMessages = session.messages || [];

        const learningPipeline = getLearningPipeline();
        const effectiveQuery = queryText && queryText.trim() ? queryText : promptText;
        const simAugWa = getSimulationChatAugmentation(effectiveQuery, {
            platform: "whatsapp",
            characterId: character.id,
            personaName: character.name,
            chatId: String(chatId),
        });
        const simActiveWa = simAugWa.activeSim;
        if (!simActiveWa) {
            learningPipeline.extractHeuristic(promptText, character.id);
        }
        const lowerQuery = effectiveQuery.toLowerCase();
        let resolvedQuery = effectiveQuery;
        if (lowerQuery.startsWith("/fetch-note-about ") || lowerQuery.startsWith("/write-about ")) {
            const topic = lowerQuery.startsWith("/fetch-note-about ") ? effectiveQuery.slice(18).trim() : effectiveQuery.slice(13).trim();
            const { prompt } = writeAboutPrompt(topic);
            if (prompt) {
                resolvedQuery = prompt;
            } else {
                return `⚠️ No notes found matching topic "${topic}".`;
            }
        }

        // Needle on-device fast-path: local-action turns skip the main LLM.
        if (resolvedQuery === effectiveQuery) {
            try {
                const fastPath = await tryNeedleFastPath(effectiveQuery, {
                    settings: this.settings,
                    activeCharacterId: character.id,
                });
                if (fastPath && fastPath.handled) {
                    sessionMessages.push({ role: "user", content: promptText });
                    sessionMessages.push({ role: "assistant", content: fastPath.reply });
                    saveSession(session.id, sessionMessages, character.id);
                    return fastPath.reply;
                }
            } catch {}
        }

        const modelMessages = [];
        const systemPromptText = composeSystemTemplate(character);
        if (systemPromptText) {
            modelMessages.push({ role: "system", content: systemPromptText });
        }
        for (const block of simAugWa.blocks.slice(0, simActiveWa ? 1 : 0)) {
            modelMessages.push({ role: "system", content: block });
        }

        // Language-scoped memories: own pool + shared first, bridge for the rest.
        const memories = retrieveMemories(resolvedQuery, 5, undefined, character.id);
        try {
            const { detectLanguage: _dl, buildLanguageScopeNote: _note } = await import("./language.js");
            const _det = _dl(resolvedQuery || "");
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
        for (const block of simAugWa.blocks.slice(simActiveWa ? 1 : 0)) {
            modelMessages.push({ role: "system", content: block });
        }

        // Daily self-reflections (association recall from data/reflections.json).
        try {
            const { getReflectionChatAugmentation } = await import("./reflections.js");
            const refAug = getReflectionChatAugmentation(resolvedQuery, { characterId: character.id, limit: 3 });
            if (refAug.block) modelMessages.push({ role: "system", content: refAug.block });
        } catch {}

        const relevantKnowledge = retrieveKnowledge(resolvedQuery, 4);
        if (relevantKnowledge.length > 0) {
            modelMessages.push({
                role: "system",
                content: `[Relevant Knowledge Base]:\n${relevantKnowledge.map((k) => `• [${k.knowledge.title} (${k.knowledge.category})]: ${k.knowledge.content}`).join("\n")}`,
            });
        }

        const chunks = retrieveNotesChunks(resolvedQuery, "notes", 5);
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
            const webHit = await runWebSearchForPrompt(resolvedQuery, this.settings);
            if (webHit.triggered && webHit.block) {
                modelMessages.push({ role: "system", content: webHit.block });
            }
        } catch {}

        const recentHistory = simActiveWa && simAugWa.historyOverride
            ? simAugWa.historyOverride.slice(-6)
            : sessionMessages.slice(-6);
        for (const h of recentHistory) {
            if (h.role === "user" || h.role === "assistant") {
                modelMessages.push({ role: h.role, content: h.content });
            }
        }

        modelMessages.push({ role: "user", content: resolvedQuery });

        try {
            const response = await unifiedChat({
                modelName: this.settings.model,
                messages: modelMessages,
                stream: false,
                settings: this.settings,
                ollamaClient: ollama,
            });

            const reply = response.content || "No response received.";
            if (simActiveWa) {
                try {
                    appendSimulationExchange(simActiveWa.slug, promptText, reply);
                    extractSimulationHeuristic(simActiveWa.slug, promptText);
                } catch {}
                return reply;
            }
            sessionMessages.push({ role: "user", content: promptText });
            sessionMessages.push({ role: "assistant", content: reply });
            saveSession(session.id, sessionMessages, character.id);

            // Trigger background incremental learning extraction (scoped to this character)
            if (this.settings.auto_learning_enabled !== false) {
                const historyContext = sessionMessages.slice(-6).map((m) => `${m.role}: ${m.content}`).join("\n");
                learningPipeline.extractWithLLM(promptText, reply, historyContext, {
                    settings: this.settings,
                    ollamaClient: ollama,
                    characterId: character.id,
                }).catch(() => {});
            }

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
                // Optional shared secret (WHATSAPP_BRIDGE_TOKEN on both sides).
                // Unset = open loopback trust, as before. The listener binds
                // 0.0.0.0, so set the token if the LAN is not trusted.
                const expectedToken = process.env.WHATSAPP_BRIDGE_TOKEN || "";
                if (expectedToken && String(req.headers["x-bridge-token"] || "") !== expectedToken) {
                    res.writeHead(403, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ ok: false, error: "forbidden" }));
                    return;
                }
                let body = "";
                let bodyTooLarge = false;
                req.on("error", () => {
                    try { res.writeHead(500, { "Content-Type": "application/json" }); } catch {}
                    try { res.end(JSON.stringify({ ok: false, error: "request error" })); } catch {}
                });
                req.on("data", (chunk) => {
                    body += chunk;
                    // 2 MB cap: /chat is text + small metadata, never megabytes.
                    if (body.length > 2 * 1024 * 1024 && !bodyTooLarge) {
                        bodyTooLarge = true;
                        try { res.writeHead(413, { "Content-Type": "application/json" }); } catch {}
                        try { res.end(JSON.stringify({ ok: false, error: "payload too large" })); } catch {}
                        try { req.destroy(); } catch {}
                    }
                });
                req.on("end", async () => {
                    if (bodyTooLarge) return;
                    try {
                        const payload = JSON.parse(body);
                        let text = String(payload.text || "").trim();
                        const remoteJid = String(payload.chat_id || payload.remoteJid || payload.remote_jid || "unknown");
                        const chatId = remoteJid;
                        const explicitGroup = payload.is_group ?? payload.isGroup ?? null;
                        const isGroup = typeof explicitGroup === "boolean" ? explicitGroup : isGroupJid(chatId);
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

                        // Serialize per chat: chain onto the previous turn's
                        // promise so concurrent deliveries can't interleave
                        // two LLM calls / session saves for the same JID.
                        const prev = this.chatQueues.get(chatId);
                        const run = (prev ? prev.catch(() => {}) : Promise.resolve()).then(() =>
                            this.processPrompt(text, chatId, { isGroup, remoteJid: chatId })
                        );
                        this.chatQueues.set(chatId, run);
                        let reply;
                        try {
                            reply = await run;
                        } finally {
                            if (this.chatQueues.get(chatId) === run) this.chatQueues.delete(chatId);
                        }

                        // null = group mention gate: no @character-name mentioned, stay silent.
                        if (reply === null || reply === undefined) {
                            res.writeHead(200, { "Content-Type": "application/json" });
                            res.end(JSON.stringify({ ok: true, reply: "", silent: true, transcribed_text: text, is_voice_input: isVoiceInput }));
                            return;
                        }

                        let voiceReplyPath = null;
                        if (this.settings.voice_reply_enabled && reply) {
                            try {
                                const outPath = path.join(process.cwd(), "tmp", `wa_reply_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.ogg`);
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
                console.log(`📱 WhatsApp HTTP Bridge listening on http://${BIND_HOST}:${this.port}/chat (already running)`);
                return;
            }
            console.error(`⚠️ WhatsApp HTTP Server Error: ${err.message}`);
        });

        this.server.listen(this.port, BIND_HOST, () => {
            console.log(`📱 WhatsApp HTTP Bridge Server listening on http://${BIND_HOST === "0.0.0.0" ? "0.0.0.0" : BIND_HOST}:${this.port}/chat`);
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
