import fs from "node:fs";
import path from "node:path";
import { loadSettings, saveSettings } from "./config.js";
import {
    loadCharacterStore,
    getActiveCharacter,
    setActiveCharacter,
    listCharacters,
    composeSystemTemplate,
} from "./characters.js";
import {
    loadSession,
    createSession,
    saveSession,
    listSessions,
    deleteSession,
    renameSession,
    retrieveSessionContext,
} from "./sessions.js";
import { loadMemories, remember, retrieveMemories } from "./memory.js";
import { retrieveKnowledge } from "./knowledge.js";
import { getLearningPipeline, getLearningStats } from "./learning.js";
import { unifiedChat as defaultUnifiedChat, DEFAULT_MODELS, getApiKey } from "./providers.js";
import {
    registerTask,
    getActiveTasks,
    getAllTasks,
    moveTask,
    deleteTask,
    formatActiveTasks,
    formatAllTasks,
} from "./tasks.js";
import { logPrompt } from "./logger.js";
import {
    WEB_SCOPE as DASHBOARD_SCOPE,
    isProbablyControlCommand,
    isSurfaceLocked,
    lockedMessage,
    runOtpCommand,
    runSecurityCommand,
} from "./security.js";

// NOTE: dashboard.js deliberately does NOT import commands.js / audio.js.
// commands.js pulls in the local ONNX audio stack (@xenova/transformers),
// which silently kills `bun test` runs. The dashboard builds its own static
// help text below (no ONNX) and dispatches interactive @ commands with
// lazy dynamic imports so plain-chat tests never load heavy modules.
export function dashboardHelpText(settings = {}) {
    const unlockMinutes = settings.security_unlock_minutes ?? 10;
    return [
        `📊 Dagowan Dashboard commands (OpenWebUI-style chat):`,
        `• Just chat — replies use the active persona + model with memory, knowledge, tasks and @live-web context.`,
        `• @help — show this help`,
        `• @stats — memory / knowledge / learning statistics`,
        `• @models — list local + cloud models (★ = active)`,
        `• @sessions — list saved chat sessions`,
        `• @tasks (or @get-tasks) / @all-tasks — Kanban tasks`,
        `• @move-task-<id>-(p|o|f) (or @move-task <id> <p|o|f>) — move a task`,
        `• @delete-task-<id> (or @delete-task <id>) — delete a task`,
        `• @remember <text> — save a persistent memory for the active persona`,
        `• @register-task <description> — add a task to Processing`,
        `• @clear — clear the active conversation context`,
        `• @youtube-play <query|URL> (or @play) — YouTube playback (API-first, browser fallback)`,
        `• @spotify-play <query|URL> (or @spotify) — Spotify playback (API-first, browser fallback)`,
        `• @blog <topic> [--on wordpress|blogger] — draft a blog post`,
        `• @astro-post <topic> [--no-push] / @astro-status / @astro-list / @astro-build — Astro site`,
        `• @fact-check <claim> (or @factcheck, @verify) — verify a claim via papers`,
        `• @web-search <query> / @web-fetch <url> / @web-status — live web tools`,
        `• @browser-search <query> / @browser-open <url> / @browser-read / @browser-shot / @browser-status / @browser-close`,
        `• @cast <url> / @cast-scan / @cast-status / @cast-stop — TV cast`,
        `• @make <desc> / @create-file <path> [content] — local coding agent`,
        `• @opencli <task> / @opencode <task> / @opencode-setup — coding agents`,
        `• @simulation <name> / @simulation-end / @simulations — persona sub-chat`,
        `• @insight [focus] / @insights / @insight-search <q> / @insight-show <id> — daily self-reflections (separate bank in data/reflections.json)`,
        `• @lock / @unlock <pin> / @security-status — security PIN (locks control commands, chat always works)`,
        `• @otp-set / @otp-login <code> / @otp-lock / @otp-status — OTP 2FA (needed before @unlock when enrolled)`,
        `• Security unlocks last ${unlockMinutes} minute(s) per surface (security_unlock_minutes).`,
        `• Tip: add @live-web anywhere in a sentence for a live web-grounded answer.`,
    ].join("\n");
}

export const DASHBOARD_DEFAULT_PORT = 8768;
const BIND_HOST = process.env.BIND_HOST || process.env.HOST || "0.0.0.0";

function parseEnabledFlag(v) {
    if (v === undefined || v === null || v === "") return null;
    const s = String(v).trim().toLowerCase();
    if (["1", "true", "on", "enable", "enabled", "yes"].includes(s)) return true;
    if (["0", "false", "off", "disable", "disabled", "no"].includes(s)) return false;
    return null;
}

function hasFlag(argv, ...names) {
    const args = Array.isArray(argv) ? argv : [];
    return names.some((n) => args.includes(n));
}

/** Resolve dashboard port: --dashboard-port N | --dashboard-port=N | --dashboard=N | -dashboard-port N | env | settings | default. */
export function resolveDashboardPort(settings = null, argv = process.argv, env = process.env) {
    const args = Array.isArray(argv) ? argv : [];
    for (let i = 0; i < args.length; i++) {
        const a = String(args[i]);
        let m = a.match(/^(?:--dashboard-port|-dashboard-port|--dashboard_port|-dashboard_port)[= ]?(\d+)?$/);
        if (m) {
            if (m[1]) return Number(m[1]);
            const next = args[i + 1];
            if (next && /^\d+$/.test(String(next))) return Number(next);
        }
        m = a.match(/^(?:--dashboard|-dashboard)[= ](\d+)$/);
        if (m && m[1]) return Number(m[1]);
        if ((a === "--dashboard" || a === "-dashboard") && nextIsPort(args[i + 1])) {
            return Number(args[i + 1]);
        }
    }
    const envPort = env.DASHBOARD_PORT || env.DASHBOARD__PORT;
    if (envPort && /^\d+$/.test(String(envPort))) return Number(envPort);
    if (settings && Number.isFinite(Number(settings.dashboard_port))) {
        const p = Number(settings.dashboard_port);
        if (p > 0 && p < 65536) return p;
    }
    return DASHBOARD_DEFAULT_PORT;
}

function nextIsPort(v) {
    return v !== undefined && v !== null && /^\d+$/.test(String(v));
}

/**
 * Central gate for the dashboard server.
 * Starts with `-dashboard` / `--dashboard` (single dash accepted per request),
 * `--dashboard-port N`, env DASHBOARD_ENABLED=1, or settings.dashboard_enabled.
 * `--no-dashboard` always wins.
 */
export function shouldStartDashboard(settings = null, argv = process.argv, env = process.env) {
    const args = Array.isArray(argv) ? argv : [];
    if (hasFlag(args, "--no-dashboard", "-no-dashboard")) {
        return { start: false, reason: "disabled-flag" };
    }
    const explicitOn =
        hasFlag(args, "--dashboard", "-dashboard") ||
        args.some((a) => String(a).startsWith("--dashboard-port") || String(a).startsWith("-dashboard-port"));
    const envFlag = parseEnabledFlag(env.DASHBOARD_ENABLED ?? env.DASHBOARD);
    if (envFlag === false && !explicitOn) return { start: false, reason: "disabled-env" };
    if (explicitOn || envFlag === true) {
        return { start: true, reason: explicitOn ? "flag" : "env", port: resolveDashboardPort(settings, argv, env) };
    }
    if (settings && settings.dashboard_enabled) {
        return { start: true, reason: "settings", port: resolveDashboardPort(settings, argv, env) };
    }
    return { start: false, reason: "disabled-default" };
}

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

async function readJsonBody(req) {
    try {
        const text = await req.text();
        if (!text) return {};
        return JSON.parse(text);
    } catch {
        return {};
    }
}

export class DashboardServer {
    constructor({ settings = null, characterStore = null, services = {} } = {}) {
        this.settings = settings || loadSettings();
        this.characterStore = characterStore || loadCharacterStore();
        this.server = null;
        this.port = null;
        this.services = {
            unifiedChat: services.unifiedChat || defaultUnifiedChat,
        };
    }

    getActiveCharacter() {
        try {
            return getActiveCharacter(this.characterStore);
        } catch {
            return { id: this.settings.active_character || "main", name: "Main" };
        }
    }

    /**
     * Chat turn shared by the REST API and unit tests.
     * Handles common @ commands locally, otherwise runs the normal
     * memory + knowledge + session-context LLM flow (non-streaming).
     */
    async handleChat({ message, sessionId = null, characterId = null } = {}) {
        const text = String(message || "").trim();
        if (!text) throw new Error("Message is required.");
        logPrompt(text, "dashboard");

        const activeChar = characterId
            ? this.characterStore.characters.find((c) => c.id === characterId || c.name === characterId) ||
              this.getActiveCharacter()
            : this.getActiveCharacter();
        const activeCharId = activeChar.id;

        // Ensure a session exists for this character.
        let session = sessionId ? loadSession(sessionId, activeCharId) : null;
        if (!session) {
            const existing = listSessions(activeCharId);
            session = existing.length > 0 && !sessionId ? existing[0] : createSession(activeCharId);
        }
        const sessionMessages = session.messages || [];

        // ---- Interactive @ command dispatch (parity with web voice bridge) ----
        // Security PIN + OTP run first on the shared "web" surface so the
        // dashboard supports @lock / @unlock / @otp-* like every other UI.
        const cmdText = text.startsWith("@") ? "/" + text.slice(1) : text;
        const cmdLower = cmdText.toLowerCase();
        const finishCommand = (reply) => {
            sessionMessages.push({ role: "user", content: text });
            sessionMessages.push({ role: "assistant", content: reply });
            try {
                saveSession(session.id, sessionMessages, activeCharId);
            } catch {}
            return { reply, sessionId: session.id, characterId: activeCharId, command: true };
        };

        {
            const secRes = runSecurityCommand(text, this.settings, DASHBOARD_SCOPE);
            if (secRes.handled) {
                if (secRes.settingsChanged) {
                    try {
                        saveSettings(this.settings);
                    } catch {}
                }
                return finishCommand(secRes.reply);
            }
            const otpRes = runOtpCommand(text, this.settings, DASHBOARD_SCOPE);
            if (otpRes.handled) {
                if (otpRes.settingsChanged) {
                    try {
                        saveSettings(this.settings);
                    } catch {}
                }
                return finishCommand(otpRes.reply);
            }
            if (isSurfaceLocked(this.settings, DASHBOARD_SCOPE)) {
                const chars = (this.characterStore && this.characterStore.characters) || [];
                let blogIntent = null;
                let astroIntent = null;
                try {
                    const { detectBlogIntent } = await import("./blog_api.js");
                    blogIntent = detectBlogIntent(text);
                } catch {}
                try {
                    const { detectAstroIntent } = await import("./astro_blog.js");
                    astroIntent = detectAstroIntent(text);
                } catch {}
                if (isProbablyControlCommand(text, chars) || blogIntent || astroIntent) {
                    return finishCommand(lockedMessage(this.settings, DASHBOARD_SCOPE));
                }
            }
        }

        if (cmdLower === "/help" || cmdLower === "/commands" || cmdLower === "/get-commands") {
            return finishCommand(dashboardHelpText(this.settings));
        }
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
            return finishCommand(lines.join("\n"));
        }
        if (cmdLower === "/models") {
            return finishCommand(await this.formatModels());
        }
        if (cmdLower === "/sessions") {
            const all = listSessions(activeCharId);
            if (all.length === 0) return finishCommand(`💬 No saved sessions for character "${activeChar.name}".`);
            const lines = [`💬 Saved Sessions for "${activeChar.name}":`];
            for (const s of all) {
                lines.push(`  • [${s.id.slice(0, 8)}] ${s.title}${s.id === session.id ? " (active)" : ""} (${(s.messages || []).length} msgs)`);
            }
            return finishCommand(lines.join("\n"));
        }
        if (cmdLower === "/tasks" || cmdLower === "/get-tasks") {
            return finishCommand(formatActiveTasks());
        }
        if (cmdLower === "/all-tasks") {
            return finishCommand(formatAllTasks());
        }
        // Task move / delete share the CLI parser so @move-task-1-p etc work.
        try {
            const { parseMoveTaskCommand, parseDeleteTaskCommand } = await import("./tasks.js");
            const moveInfo = parseMoveTaskCommand(text);
            if (moveInfo) {
                const res = moveTask(moveInfo.taskId, moveInfo.status);
                return finishCommand(res.success ? `📋 Task #${res.task.id} moved to ${res.task.status}.` : `⚠️ ${res.message}`);
            }
            const delTaskId = parseDeleteTaskCommand(text);
            if (delTaskId !== null) {
                const res = deleteTask(delTaskId);
                return finishCommand(res.success ? `🗑 Task #${res.task.id} deleted.` : `⚠️ ${res.message}`);
            }
        } catch {}
        if (cmdLower.startsWith("/remember ")) {
            const memText = text.slice(10).trim();
            if (!memText) return finishCommand("⚠️ Usage: @remember <text>");
            remember(memText, undefined, activeCharId);
            return finishCommand(`🧠 Memory saved & context refreshed: "${memText}"`);
        }
        if (cmdLower.startsWith("/register-task ")) {
            const taskText = text.slice(15).trim();
            if (!taskText) return finishCommand("⚠️ Usage: @register-task <description>");
            const task = registerTask(taskText, "p");
            return finishCommand(`📋 Task "#${task.id}" registered into Processing (p) status.`);
        }
        if (cmdLower === "/clear") {
            const cleared = [];
            try {
                saveSession(session.id, cleared, activeCharId);
            } catch {}
            return { reply: "🧹 Active conversation context cleared.", sessionId: session.id, characterId: activeCharId, command: true };
        }

        // Delegate every other interactive tool command to the shared
        // web-surface dispatcher (lazy imports keep plain-chat tests light).
        {
            const toolReply = await this.handleToolCommand({
                text,
                cmdText,
                cmdLower,
                session,
                sessionMessages,
                activeChar,
                activeCharId,
            });
            if (toolReply !== null) return finishCommand(toolReply);
        }

        // ---- Normal LLM turn ----
        const learningPipeline = getLearningPipeline();
        // Simulation-aware: plain chat inside an active web simulation is
        // archived to the simulation file (same persona, separate thread).
        let simActive = null;
        let simHistoryOverride = null;
        let simBlocks = [];
        try {
            const sim = await import("./simulation.js");
            const aug = sim.getSimulationChatAugmentation(text, {
                platform: "web",
                characterId: activeCharId,
                personaName: activeChar.name,
                chatId: String(session.id),
            });
            simActive = aug.activeSim || null;
            simHistoryOverride = aug.historyOverride || null;
            simBlocks = Array.isArray(aug.blocks) ? aug.blocks : [];
        } catch {}
        if (!simActive) {
            try {
                learningPipeline.extractHeuristic(text, activeCharId);
            } catch {}
        }

        const modelMessages = [];
        const systemPromptText = composeSystemTemplate(activeChar);
        if (systemPromptText) modelMessages.push({ role: "system", content: systemPromptText });
        for (const block of simBlocks.slice(0, simActive ? 1 : 0)) {
            modelMessages.push({ role: "system", content: block });
        }

        let relevantMemories = [];
        let relevantKnowledge = [];
        let pastContext = [];
        try {
            const { retrieveChatContextParallel } = await import("./chat_context.js");
            const ctx = await retrieveChatContextParallel(text, {
                characterId: activeCharId,
                excludeSessionId: session.id,
                memoryLimit: 5,
                knowledgeLimit: 4,
                sessionLimit: 3,
                simulationLimit: 0,
            });
            relevantMemories = ctx.memories;
            relevantKnowledge = ctx.knowledge;
            pastContext = ctx.pastContext;
            if (ctx.language) {
                const { buildLanguageScopeNote } = await import("./language.js");
                const note = buildLanguageScopeNote(ctx.language, ctx.bridgeHits || 0);
                if (note) modelMessages.push({ role: "system", content: note });
            }
        } catch {
            relevantMemories = retrieveMemories(text, 5, undefined, activeCharId);
            relevantKnowledge = retrieveKnowledge(text, 4);
            pastContext = retrieveSessionContext(text, session.id, 3, activeCharId);
        }
        if (relevantMemories.length > 0) {
            modelMessages.push({
                role: "system",
                content: `[Relevant Persistent Memories]:\n${relevantMemories.map((m) => `• ${m}`).join("\n")}`,
            });
        }
        try {
            const { getReflectionChatAugmentation } = await import("./reflections.js");
            const refAug = getReflectionChatAugmentation(text, { characterId: activeCharId, limit: 3 });
            if (refAug.block) modelMessages.push({ role: "system", content: refAug.block });
        } catch {}
        for (const block of simBlocks.slice(simActive ? 1 : 0)) {
            modelMessages.push({ role: "system", content: block });
        }
        if (relevantKnowledge.length > 0) {
            modelMessages.push({
                role: "system",
                content: `[Relevant Knowledge Base]:\n${relevantKnowledge.map((k) => `• [${k.knowledge.title} (${k.knowledge.category})]: ${k.knowledge.content}`).join("\n")}`,
            });
        }
        if (pastContext.length > 0) {
            const formatted = pastContext.map((item) => `[From "${item.session_title}"] ${item.role}: ${item.content}`).join("\n");
            modelMessages.push({ role: "system", content: `[Relevant Past Conversation Context]:\n${formatted}` });
        }
        const lower = text.toLowerCase();
        if (lower.includes("task") || lower.includes("kanban") || lower.includes("todo") || lower.includes("progress")) {
            modelMessages.push({ role: "system", content: `[Current Active Tasks Context]:\n${formatActiveTasks()}` });
        }
        try {
            const { runWebSearchForPrompt } = await import("./websearch.js");
            const webHit = await runWebSearchForPrompt(text, this.settings);
            if (webHit.triggered && webHit.block) modelMessages.push({ role: "system", content: webHit.block });
        } catch {}

        const historySource = simActive && simHistoryOverride ? simHistoryOverride : sessionMessages;
        const historyWindow = historySource.slice(-(this.settings.mem_limit || 10) * 2);
        for (const h of historyWindow) {
            if (h.role === "user" || h.role === "assistant") modelMessages.push({ role: h.role, content: h.content });
        }
        modelMessages.push({ role: "user", content: text });

        const { Ollama } = await import("ollama");
        const ollamaClient = new Ollama({ host: this.settings.server_url });
        const llmRes = await this.services.unifiedChat({
            modelName: this.settings.model,
            messages: modelMessages,
            stream: false,
            settings: this.settings,
            ollamaClient,
        });
        const replyText = (llmRes.content || "No response generated.").trim();

        if (simActive) {
            try {
                const sim = await import("./simulation.js");
                sim.appendSimulationExchange(simActive.slug, text, replyText);
                sim.extractSimulationHeuristic(simActive.slug, text);
            } catch {}
            return { reply: replyText, sessionId: session.id, characterId: activeCharId, command: false, simulation: simActive.slug };
        }

        sessionMessages.push({ role: "user", content: text });
        sessionMessages.push({ role: "assistant", content: replyText });
        saveSession(session.id, sessionMessages, activeCharId);

        if (this.settings.auto_learning_enabled !== false) {
            const historyContext = sessionMessages.slice(-6).map((m) => `${m.role}: ${m.content}`).join("\n");
            learningPipeline
                .extractWithLLM(text, replyText, historyContext, {
                    settings: this.settings,
                    ollamaClient,
                    characterId: activeCharId,
                })
                .catch(() => {});
        }

        return { reply: replyText, sessionId: session.id, characterId: activeCharId, command: false };
    }

    /**
     * Interactive tool commands for the web surface (parity with the voice
     * bridge processTextQuery). Returns a reply string when `text` is a tool
     * command, or null when it is plain chat (caller falls through to LLM).
     * All heavy modules are lazily imported so plain-chat unit tests never
     * pay the Playwright/ONNX load cost.
     */
    async handleToolCommand({ text, cmdText, cmdLower, session, sessionMessages, activeChar, activeCharId } = {}) {
        const persistSettings = () => {
            try {
                saveSettings(this.settings);
            } catch {}
        };

        // ---- Local coding agent: @make / @create-file ----
        if (cmdLower === "/make" || cmdLower.startsWith("/make ")) {
            const promptText = cmdText.slice(5).trim();
            if (!promptText) return "⚠️ Usage: @make <project description>\nExample: @make Create a python script in server.py";
            try {
                const { runMakeCommand } = await import("./ollama_coding.js");
                const res = await runMakeCommand(promptText, this.settings);
                return res.output || "🔨 Project task completed!";
            } catch (err) {
                return `⚠️ @make error: ${err.message || err}`;
            }
        }
        if (cmdLower === "/create-file" || cmdLower.startsWith("/create-file ")) {
            const payload = cmdText.slice(12).trim();
            if (!payload) return "⚠️ Usage: @create-file <file_path> [content|prompt]";
            const firstSpaceIdx = payload.search(/\s/);
            let filePath = payload;
            let contentOrPrompt = "";
            if (firstSpaceIdx !== -1) {
                filePath = payload.slice(0, firstSpaceIdx).trim();
                contentOrPrompt = payload.slice(firstSpaceIdx + 1).trim();
            }
            try {
                const { runCreateFileCommand } = await import("./ollama_coding.js");
                const res = await runCreateFileCommand(filePath, contentOrPrompt, this.settings);
                return res.success ? `📄 ${res.output}` : `⚠️ ${res.error}`;
            } catch (err) {
                return `⚠️ @create-file error: ${err.message || err}`;
            }
        }

        // ---- YouTube / Spotify playback (@play / @spotify) ----
        if (cmdLower === "/play" || cmdLower.startsWith("/play ") || cmdLower.startsWith("/youtube-play")) {
            try {
                const { parsePlayInput, formatPlayResult } = await import("./browser.js");
                const { playYoutube } = await import("./play_api.js");
                const parsed = parsePlayInput(cmdText);
                if (!parsed || !parsed.query) return "⚠️ Usage: @youtube-play <search terms or YouTube URL> [--no-show]";
                const res = await playYoutube(parsed.query, this.settings, { show: parsed.show });
                return formatPlayResult(res);
            } catch (err) {
                return `⚠️ @play error: ${err.message || err}`;
            }
        }
        if (cmdLower === "/spotify" || cmdLower.startsWith("/spotify ") || cmdLower.startsWith("/spotify-play")) {
            try {
                const { parseSpotifyPlayInput, formatSpotifyPlayResult } = await import("./browser.js");
                const { playSpotify } = await import("./play_api.js");
                const parsed = parseSpotifyPlayInput(cmdText);
                if (!parsed || !parsed.query) return "⚠️ Usage: @spotify-play <search terms or Spotify URL> [--no-show]";
                const res = await playSpotify(parsed.query, this.settings, { show: parsed.show });
                return formatSpotifyPlayResult(res);
            } catch (err) {
                return `⚠️ @spotify error: ${err.message || err}`;
            }
        }

        // ---- Astro site ----
        try {
            const astro = await import("./astro_blog.js");
            const parsed = astro.parseAstroInput(cmdText);
            if (parsed) {
                if (parsed.action === "path") {
                    if (!parsed.path) {
                        const st = astro.getAstroStatus(this.settings);
                        return `📁 Astro project path: "${st.project}" (${st.configured ? `${st.posts} post(s)` : "missing — set with @astro-path <dir>"})`;
                    }
                    this.settings.astro_project_path = parsed.path;
                    persistSettings();
                    return `📁 Astro project path saved: "${parsed.path}"`;
                }
                if (parsed.action === "status") return astro.formatAstroResult({ success: true, action: "status", status: astro.getAstroStatus(this.settings) });
                if (parsed.action === "list") {
                    const res = astro.listAstroPosts(this.settings, { limit: parsed.limit });
                    return astro.formatAstroResult({ success: res.success, action: "list", files: res.files, error: res.error });
                }
                if (parsed.action === "build") return astro.formatAstroResult(await astro.buildAstroSite(this.settings, {}));
                if (parsed.action === "vault") return astro.formatAstroResult(astro.syncAstroVault(this.settings, {}));
                if (parsed.action === "publish") {
                    return astro.formatAstroResult(await astro.publishAstroToGit(this.settings, { message: parsed.message }, null));
                }
                if (parsed.action === "post") {
                    if (!parsed.topic) return "⚠️ Usage: @astro-post <topic> [--lang lt|en] [--template daily|generic] [--no-push]";
                    const { Ollama } = await import("ollama");
                    const ollamaClient = new Ollama({ host: this.settings.server_url });
                    const res = await astro.publishAstroPost(parsed.topic, this.settings, {
                        title: parsed.title,
                        lang: parsed.lang,
                        template: parsed.template,
                        date: parsed.date,
                        slug: parsed.slug,
                        description: parsed.description,
                        message: parsed.message || `astro: ${parsed.topic}`.slice(0, 200),
                        dryRun: parsed.dryRun,
                        build: parsed.build,
                        push: parsed.push,
                        vault: parsed.vault,
                        settings: this.settings,
                        ollamaClient,
                        characterPersona: composeSystemTemplate(activeChar),
                        characterName: activeChar.name,
                    });
                    return astro.formatAstroResult(res);
                }
            }
            const astroIntent = astro.detectAstroIntent(text);
            if (astroIntent) {
                const { Ollama } = await import("ollama");
                const ollamaClient = new Ollama({ host: this.settings.server_url });
                const res = await astro.publishAstroPost(astroIntent.topic, this.settings, {
                    settings: this.settings,
                    ollamaClient,
                    characterPersona: composeSystemTemplate(activeChar),
                    characterName: activeChar.name,
                });
                return astro.formatAstroResult(res);
            }
        } catch (err) {
            if (err && /usage/i.test(String(err.message || ""))) return `⚠️ ${err.message}`;
        }

        // ---- Blog drafts + natural blog intent ----
        try {
            const blogApi = await import("./blog_api.js");
            const { parseBlogInput, formatBlogDraftResult } = await import("./browser.js");
            const blogParsed = parseBlogInput(cmdText);
            if (blogParsed) {
                if (!blogParsed.topic) return "⚠️ Usage: @blog <topic> [--on wordpress|blogger] [--title <title>] [--no-show]";
                const { Ollama } = await import("ollama");
                const ollamaClient = new Ollama({ host: this.settings.server_url });
                const res = await blogApi.draftBlog(blogParsed.topic, this.settings, {
                    platform: blogParsed.platform,
                    title: blogParsed.title,
                    show: blogParsed.show,
                    settings: this.settings,
                    ollamaClient,
                    characterPersona: composeSystemTemplate(activeChar),
                    characterName: activeChar.name,
                });
                return formatBlogDraftResult(res);
            }
            const blogIntent = blogApi.detectBlogIntent(text);
            if (blogIntent) {
                const { Ollama } = await import("ollama");
                const ollamaClient = new Ollama({ host: this.settings.server_url });
                const res = await blogApi.draftBlog(blogIntent.topic, this.settings, {
                    platform: blogIntent.platform,
                    show: true,
                    settings: this.settings,
                    ollamaClient,
                    characterPersona: composeSystemTemplate(activeChar),
                    characterName: activeChar.name,
                });
                return formatBlogDraftResult(res);
            }
        } catch (err) {
            if (err && /usage/i.test(String(err.message || ""))) return `⚠️ ${err.message}`;
        }

        // ---- Fact-check ----
        try {
            const fact = await import("./factcheck_api.js");
            const factParsed = fact.parseFactCheckInput(cmdText, this.settings);
            if (factParsed) {
                if (!factParsed.claim) return "⚠️ Usage: @fact-check <claim> [--limit N] [--source auto|papers|gemini]";
                const res = await fact.checkFactClaim(factParsed.claim, this.settings, {
                    maxResults: factParsed.maxResults,
                    source: factParsed.source,
                    model: factParsed.model,
                    verdict: factParsed.verdict,
                });
                return fact.formatFactCheckResult(res);
            }
        } catch {}

        // ---- Live web search / fetch / status ----
        try {
            const web = await import("./websearch.js");
            if (web.parseWebStatusCommand(text)) return web.formatWebStatus(this.settings);
            const webSearchCmd = web.parseWebSearchCommand(text, this.settings);
            if (webSearchCmd) {
                if (!webSearchCmd.query) {
                    return '⚠️ Usage: @web-search <query> [--provider auto|duckduckgo|brave|tavily] [--limit N]\nInline form: mention @live-web anywhere in a sentence ("latest BTC price @live-web")';
                }
                const res = await web.searchWeb(webSearchCmd.query, this.settings, { provider: webSearchCmd.provider, maxResults: webSearchCmd.maxResults });
                return web.formatWebResults(res);
            }
            const webFetchCmd = web.parseWebFetchCommand(text);
            if (webFetchCmd) {
                if (!webFetchCmd.url) return "⚠️ Usage: @web-fetch <url>";
                const res = await web.fetchPageText(webFetchCmd.url, this.settings);
                return web.formatPageText(res);
            }
        } catch {}

        // ---- Local browser tools ----
        if (cmdLower.startsWith("/browser-search-spotify ")) {
            const query = cmdText.slice("/browser-search-spotify".length).trim();
            if (!query) return "⚠️ Usage: @browser-search-spotify <query>";
            try {
                const { browserSearchSpotify } = await import("./browser.js");
                const res = await browserSearchSpotify(query, this.settings);
                if (!res.success || !res.results || res.results.length === 0) return `⚠️ No results: ${(res && res.error) || "empty result set"}`;
                return `🎧 Top Spotify results for "${query}":\n` + res.results.map((r, i) => `${i + 1}. ${r.title} [${r.kind || "track"}]\n   ${r.url}`).join("\n");
            } catch (err) {
                return `⚠️ Browser search error: ${err.message || err}`;
            }
        }
        if (cmdLower.startsWith("/browser-search ")) {
            const query = cmdText.slice("/browser-search".length).trim();
            if (!query) return "⚠️ Usage: @browser-search <query>";
            try {
                const { browserSearchYoutube } = await import("./browser.js");
                const res = await browserSearchYoutube(query, this.settings);
                if (!res.success || !res.results || res.results.length === 0) return `⚠️ No results: ${(res && res.error) || "empty result set"}`;
                return `🌐 Top YouTube results for "${query}":\n` + res.results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}`).join("\n");
            } catch (err) {
                return `⚠️ Browser search error: ${err.message || err}`;
            }
        }
        if (cmdLower.startsWith("/browser-open ")) {
            const url = cmdText.slice("/browser-open".length).trim();
            if (!url) return "⚠️ Usage: @browser-open <url>";
            try {
                const { browserOpen } = await import("./browser.js");
                const res = await browserOpen(url, this.settings);
                return res.success ? `🌐 Browser at: "${res.title || "(untitled)"}"\n🔗 ${res.url}` : `⚠️ ${res.error}`;
            } catch (err) {
                return `⚠️ Browser error: ${err.message || err}`;
            }
        }
        if (cmdLower === "/browser-read") {
            try {
                const { browserRead } = await import("./browser.js");
                const res = await browserRead(this.settings);
                return res.success ? `🌐 [${res.title || res.url}]\n${res.text}` : `⚠️ ${res.error}`;
            } catch (err) {
                return `⚠️ Browser error: ${err.message || err}`;
            }
        }
        if (cmdLower === "/browser-shot" || cmdLower.startsWith("/browser-shot ")) {
            try {
                const { browserScreenshot } = await import("./browser.js");
                const res = await browserScreenshot(cmdText.slice("/browser-shot".length).trim(), this.settings);
                return res.success ? `📸 Screenshot saved: ${res.path}` : `⚠️ ${res.error}`;
            } catch (err) {
                return `⚠️ Browser error: ${err.message || err}`;
            }
        }
        if (cmdLower === "/browser-status") {
            try {
                const { browserStatus } = await import("./browser.js");
                const st = await browserStatus(this.settings);
                return `🌐 Browser: ${st.launched ? "running" : "stopped"} (${st.headless ? "headless fallback" : "visible window"})` +
                    (st.url ? `\n🔗 ${st.title || ""} ${st.url}` : "") +
                    `\n✅ Allowed: ${st.allowed.join(", ")}`;
            } catch (err) {
                return `⚠️ Browser error: ${err.message || err}`;
            }
        }
        if (cmdLower === "/browser-close") {
            try {
                const { browserClose } = await import("./browser.js");
                await browserClose();
                return "🌐 Local browser closed.";
            } catch (err) {
                return `⚠️ Browser error: ${err.message || err}`;
            }
        }

        // ---- TV cast ----
        try {
            const { parseCastInput } = await import("./cast/caster.js");
            if (parseCastInput(cmdText)) {
                const { runCastCommand } = await import("./cast/caster.js");
                const res = await runCastCommand(cmdText, this.settings);
                if (res.settingsChanged) persistSettings();
                return Array.isArray(res.reply) ? res.reply.join("\n") : String(res.reply);
            }
        } catch (err) {
            return `⚠️ Cast error: ${err.message || err}`;
        }

        // ---- Voice reply toggle ----
        if (cmdLower.startsWith("/voice-reply") || cmdLower === "/voicereply" || cmdLower.startsWith("/voice-mode") || cmdLower === "/voicemode") {
            const parts = text.split(/\s+/);
            const arg = (parts[1] || "").toLowerCase();
            if (arg === "on" || arg === "true" || arg === "1") this.settings.voice_reply_enabled = true;
            else if (arg === "off" || arg === "false" || arg === "0") this.settings.voice_reply_enabled = false;
            else this.settings.voice_reply_enabled = !this.settings.voice_reply_enabled;
            persistSettings();
            return `🔊 Automatic Local Voice Reply / Voice Mode is now: ${this.settings.voice_reply_enabled ? "ENABLED (ON)" : "DISABLED (OFF)"}`;
        }

        // ---- PDF conversion ----
        if (cmdLower.startsWith("/convert-pdf") || cmdLower.startsWith("/pdf")) {
            try {
                const { convertNotesToPdf } = await import("./pdf_utils.js");
                const parts = text.split(/\s+/);
                const res = await convertNotesToPdf("notes", "pdfs", parts[1] || "", parts[2] || "");
                return res.success ? `📄 ${res.output}` : `⚠️ ${res.error}`;
            } catch (err) {
                return `⚠️ PDF error: ${err.message || err}`;
            }
        }
        if (cmdLower.startsWith("/pdf-to-md") || cmdLower.startsWith("/convert-md")) {
            const parts = text.split(/\s+/);
            const pdfFile = parts[1] || "";
            if (!pdfFile) return "⚠️ Usage: @pdf-to-md <filename.pdf>";
            try {
                const { convertPdfToMd } = await import("./pdf_utils.js");
                const res = await convertPdfToMd(pdfFile, "notes");
                return res.success ? `📄 ${res.output}` : `⚠️ ${res.error}`;
            } catch (err) {
                return `⚠️ PDF error: ${err.message || err}`;
            }
        }

        // ---- Backup / restore ----
        if (cmdLower.startsWith("/export-settings") || cmdLower.startsWith("/backup")) {
            try {
                const { exportSettings } = await import("./config.js");
                const backupPath = exportSettings();
                return `💾 Backup created: ${backupPath}`;
            } catch (err) {
                return `⚠️ Backup error: ${err.message || err}`;
            }
        }
        if (cmdLower.startsWith("/import-settings") || cmdLower.startsWith("/restore")) {
            try {
                const { importSettings } = await import("./config.js");
                const parts = text.split(/\s+/);
                const res = importSettings(parts[1] || "");
                return res.success ? `✅ ${res.message}` : `⚠️ ${res.message}`;
            } catch (err) {
                return `⚠️ Restore error: ${err.message || err}`;
            }
        }

        // ---- OpenCLI / opencode coding agents (dashboard is a local surface) ----
        if (cmdLower === "/opencli" || cmdLower.startsWith("/opencli ")) {
            const taskText = cmdText.slice(8).trim();
            if (!taskText) return "⚠️ Usage: @opencli <project or coding task description>";
            try {
                const { runOpenCliCommand } = await import("./opencli.js");
                const res = await runOpenCliCommand(taskText, this.settings, { senderId: "web" });
                return res.success ? `🤖 ${res.output}` : `${res.error}`;
            } catch (err) {
                return `⚠️ @opencli error: ${err.message || err}`;
            }
        }
        if (cmdLower === "/opencode-setup-auto-allow" || cmdLower.startsWith("/opencode-setup-auto-allow ")) {
            const modeArgs = cmdText.slice(26).trim();
            try {
                const { runOpencodeSetupStep } = await import("./opencode.js");
                const res = await runOpencodeSetupStep(`auto-allow ${modeArgs}`.trim(), this.settings, { senderId: "web" });
                if (res.settingsChanged) persistSettings();
                return res.reply;
            } catch (err) {
                return `⚠️ @opencode-setup-auto-allow error: ${err.message || err}`;
            }
        }
        if (cmdLower === "/opencode-setup" || cmdLower.startsWith("/opencode-setup ")) {
            const stepArgs = cmdText.slice(15).trim();
            try {
                const { runOpencodeSetupStep } = await import("./opencode.js");
                const res = await runOpencodeSetupStep(stepArgs, this.settings, { senderId: "web" });
                if (res.settingsChanged) persistSettings();
                return res.reply;
            } catch (err) {
                return `⚠️ @opencode-setup error: ${err.message || err}`;
            }
        }
        if (cmdLower === "/opencode-model" || cmdLower.startsWith("/opencode-model ")) {
            const arg = cmdText.slice(15).trim();
            try {
                const { getEffectiveOpencodeModel, requireExplicitProjectPath } = await import("./opencode.js");
                if (!arg) {
                    let projectPath = null;
                    try {
                        projectPath = requireExplicitProjectPath(this.settings);
                    } catch {}
                    const eff = getEffectiveOpencodeModel(this.settings || {}, projectPath);
                    return `🤖 @opencode model: ${eff.model || "(opencode default)"} [${eff.source}]\n💡 Set it: @opencode-model <provider/model>`;
                }
                this.settings.opencode_model = arg;
                persistSettings();
                return `🤖 @opencode model set to "${arg}".`;
            } catch (err) {
                return `⚠️ @opencode-model error: ${err.message || err}`;
            }
        }
        if (cmdLower === "/opencode" || cmdLower.startsWith("/opencode ")) {
            const taskText = cmdText.slice(9).trim();
            if (!taskText) return "⚠️ Usage: @opencode <project or coding task description>\nNeeds @set-project-path <dir> first; model via @opencode-model or opencode's own config.";
            try {
                const { runOpencodeCommand, formatOpencodeFinish } = await import("./opencode.js");
                const startedAt = Date.now();
                const res = await runOpencodeCommand(taskText, this.settings, { senderId: "web" });
                return formatOpencodeFinish(taskText, res, res.elapsedMs ?? (Date.now() - startedAt));
            } catch (err) {
                return `⚠️ @opencode error: ${err.message || err}`;
            }
        }

        // ---- Simulation sub-chat (same persona, web platform scope) ----
        try {
            const sim = await import("./simulation.js");
            const simCmd = sim.handleSimulationBridgeCommand(text, {
                platform: "web",
                characterId: activeCharId,
                personaName: activeChar.name,
                chatId: String(session.id),
            });
            if (simCmd.handled) return simCmd.reply;
        } catch {}

        // ---- Daily self-reflections (@insight family; lock-gated by caller) ----
        try {
            const ref = await import("./reflections.js");
            if (ref.parseInsightCommand(text)) {
                const { Ollama } = await import("ollama");
                let dashOllama = null;
                try { dashOllama = new Ollama({ host: this.settings.server_url }); } catch {}
                const res = await ref.handleReflectionBridgeCommand(text, {
                    characterId: activeCharId,
                    personaName: activeChar.name,
                    settings: this.settings,
                    ollamaClient: dashOllama,
                });
                if (res.handled) return res.reply;
            }
        } catch {}

        // ---- Needle on-device fast-path (local-action turns skip the LLM) ----
        try {
            const { tryNeedleFastPath } = await import("./needle.js");
            const fastPath = await tryNeedleFastPath(text, {
                settings: this.settings,
                activeCharacterId: activeCharId,
            });
            if (fastPath && fastPath.handled) return fastPath.reply;
        } catch {}

        return null;
    }

    async formatModels() {
        const lines = [`🤖 Available Multi-Provider LLM Models:`, `  🦙 Ollama (Local):`];
        try {
            const ollama = (await import("ollama")).default;
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
        return lines.join("\n");
    }

    async handleRequest(req) {
        const url = new URL(req.url);
        const pathname = url.pathname;
        const lockedRest = () => {
            if (isSurfaceLocked(this.settings, DASHBOARD_SCOPE)) {
                return jsonResponse({ error: lockedMessage(this.settings, DASHBOARD_SCOPE) }, 423);
            }
            return null;
        };

        if (req.method === "GET" && (pathname === "/" || pathname === "/dashboard")) {
            const htmlPath = path.join(process.cwd(), "dashboard.html");
            if (fs.existsSync(htmlPath)) {
                return new Response(fs.readFileSync(htmlPath, "utf8"), {
                    headers: { "Content-Type": "text/html; charset=utf-8" },
                });
            }
            return new Response("Dashboard HTML file missing.", { status: 444 });
        }

        if (pathname === "/api/health") {
            return jsonResponse({
                ok: true,
                service: "dagowan-dashboard",
                model: this.settings.model,
                character: this.getActiveCharacter().id,
                time: new Date().toISOString(),
            });
        }

        if (req.method === "GET" && pathname === "/api/models") {
            let ollamaModels = [];
            try {
                const ollama = (await import("ollama")).default;
                const list = await ollama.list();
                ollamaModels = (list.models || []).map((m) => m.name);
            } catch {}
            return jsonResponse({
                active: this.settings.model,
                ollama: ollamaModels,
                cloud: DEFAULT_MODELS,
                providers: {
                    openai: !!getApiKey("openai", this.settings),
                    gemini: !!getApiKey("gemini", this.settings),
                    claude: !!getApiKey("claude", this.settings),
                    grok: !!getApiKey("grok", this.settings),
                },
            });
        }

        if (req.method === "GET" && pathname === "/api/characters") {
            return jsonResponse({ active: this.characterStore.active_character, characters: listCharacters(this.characterStore) });
        }

        if (req.method === "POST" && pathname === "/api/characters/switch") {
            const locked = lockedRest();
            if (locked) return locked;
            const body = await readJsonBody(req);
            const id = String(body.id || body.characterId || "").trim();
            if (!id) return jsonResponse({ error: "Character id is required." }, 400);
            const res = setActiveCharacter(this.characterStore, id);
            if (!res.success) return jsonResponse({ error: res.message }, 404);
            this.settings.active_character = res.activeCharacter.id;
            try {
                saveSettings(this.settings);
            } catch {}
            return jsonResponse({ ok: true, active: res.activeCharacter.id, character: { id: res.activeCharacter.id, name: res.activeCharacter.name } });
        }

        if (pathname === "/api/sessions" && req.method === "GET") {
            const characterId = url.searchParams.get("characterId") || this.getActiveCharacter().id;
            return jsonResponse({ sessions: listSessions(characterId) });
        }

        if (pathname === "/api/sessions" && req.method === "POST") {
            const locked = lockedRest();
            if (locked) return locked;
            const body = await readJsonBody(req);
            const characterId = String(body.characterId || this.getActiveCharacter().id);
            const session = createSession(characterId);
            if (body.title) {
                renameSession(session.id, String(body.title), characterId);
                const reloaded = loadSession(session.id, characterId);
                return jsonResponse({ session: reloaded || session }, 201);
            }
            return jsonResponse({ session }, 201);
        }

        {
            const m = pathname.match(/^\/api\/sessions\/([^/]+)$/);
            if (m) {
                const sid = decodeURIComponent(m[1]);
                if (req.method === "GET") {
                    const characterId = url.searchParams.get("characterId") || null;
                    const session = loadSession(sid, characterId);
                    if (!session) return jsonResponse({ error: "Session not found." }, 404);
                    return jsonResponse({ session });
                }
                if (req.method === "DELETE") {
                    const locked = lockedRest();
                    if (locked) return locked;
                    const body = req.method === "DELETE" ? {} : await readJsonBody(req);
                    const res = deleteSession(sid, body.characterId || null);
                    if (!res.success) return jsonResponse({ error: res.message }, 404);
                    return jsonResponse({ ok: true });
                }
                if (req.method === "PATCH" || req.method === "PUT") {
                    const locked = lockedRest();
                    if (locked) return locked;
                    const body = await readJsonBody(req);
                    if (!body.title) return jsonResponse({ error: "Title is required." }, 400);
                    const res = renameSession(sid, String(body.title), body.characterId || null);
                    if (!res.success) return jsonResponse({ error: res.message }, 404);
                    return jsonResponse({ ok: true, session: res.session });
                }
            }
        }

        if (req.method === "POST" && pathname === "/api/chat") {
            const body = await readJsonBody(req);
            try {
                const result = await this.handleChat({
                    message: body.message,
                    sessionId: body.sessionId || null,
                    characterId: body.characterId || null,
                });
                return jsonResponse(result);
            } catch (err) {
                return jsonResponse({ error: err.message || String(err) }, 400);
            }
        }

        if (req.method === "GET" && pathname === "/api/memories") {
            const q = url.searchParams.get("query") || url.searchParams.get("q") || "";
            const characterId = url.searchParams.get("characterId") || this.getActiveCharacter().id;
            const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 15), 1), 100);
            const memories = q ? retrieveMemories(q, limit, undefined, characterId) : [];
            let recent = [];
            try {
                const { getMemoryStore } = await import("./memory.js");
                const store = getMemoryStore();
                recent = store
                    .listMemories({ characterId, status: "active" })
                    .slice(0, limit)
                    .map((mem) => `[${mem.id}] ${mem.content}`);
            } catch {}
            return jsonResponse({ query: q, memories: q ? memories : recent });
        }

        if (req.method === "POST" && pathname === "/api/memories") {
            const locked = lockedRest();
            if (locked) return locked;
            const body = await readJsonBody(req);
            const text = String(body.text || body.content || "").trim();
            if (!text) return jsonResponse({ error: "Text is required." }, 400);
            const characterId = String(body.characterId || this.getActiveCharacter().id);
            const mem = remember(text, undefined, characterId);
            return jsonResponse({ ok: true, memory: { id: mem.id, content: mem.content, language: mem.language } }, 201);
        }

        if (req.method === "GET" && pathname === "/api/tasks") {
            const all = url.searchParams.get("all") === "1";
            const tasks = all ? getAllTasks() : getActiveTasks();
            return jsonResponse({ tasks, formatted: all ? formatAllTasks() : formatActiveTasks() });
        }

        if (req.method === "POST" && pathname === "/api/tasks") {
            const locked = lockedRest();
            if (locked) return locked;
            const body = await readJsonBody(req);
            const text = String(body.text || body.description || "").trim();
            if (!text) return jsonResponse({ error: "Task text is required." }, 400);
            const task = registerTask(text, "p");
            return jsonResponse({ ok: true, task }, 201);
        }

        {
            const m = pathname.match(/^\/api\/tasks\/([^/]+)\/(move|delete)$/);
            if (m && req.method === "POST") {
                const locked = lockedRest();
                if (locked) return locked;
                const taskId = Number(decodeURIComponent(m[1]));
                if (m[2] === "move") {
                    const body = await readJsonBody(req);
                    const res = moveTask(taskId, body.status || "f");
                    if (!res.success) return jsonResponse({ error: res.message }, 404);
                    return jsonResponse({ ok: true, task: res.task });
                }
                const res = deleteTask(taskId);
                if (!res.success) return jsonResponse({ error: res.message }, 404);
                return jsonResponse({ ok: true });
            }
        }

        if (req.method === "GET" && pathname === "/api/stats") {
            return jsonResponse(getLearningStats());
        }

        if (req.method === "GET" && pathname === "/api/settings") {
            return jsonResponse({ settings: this.settings });
        }

        if ((req.method === "POST" || req.method === "PATCH") && pathname === "/api/settings") {
            const locked = lockedRest();
            if (locked) return locked;
            const body = await readJsonBody(req);
            const patch = body.settings || body;
            const allowed = new Set([
                "model",
                "server_url",
                "system_template",
                "mem_limit",
                "auto_learning_enabled",
                "websearch_enabled",
                "websearch_provider",
                "websearch_max_results",
                "task_reminder_enabled",
                "task_reminder_minutes",
                "proactive_chat_enabled",
                "proactive_idle_seconds",
                "voice_reply_enabled",
                "project_path",
                "dashboard_port",
            ]);
            let changed = false;
            for (const [k, v] of Object.entries(patch || {})) {
                if (!allowed.has(k)) continue;
                this.settings[k] = v;
                changed = true;
            }
            if (changed) {
                try {
                    saveSettings(this.settings);
                } catch {}
            }
            return jsonResponse({ ok: true, settings: this.settings, changed });
        }

        if (req.method === "POST" && pathname === "/api/model") {
            const locked = lockedRest();
            if (locked) return locked;
            const body = await readJsonBody(req);
            const model = String(body.model || "").trim();
            if (!model) return jsonResponse({ error: "Model name is required." }, 400);
            this.settings.model = model;
            try {
                saveSettings(this.settings);
            } catch {}
            return jsonResponse({ ok: true, model });
        }

        if (req.method === "GET" && pathname === "/api/commands") {
            return jsonResponse({ help: dashboardHelpText(this.settings) });
        }

        if (req.method === "GET" && pathname === "/api/security-status") {
            const { isSecurityPinSet, isScopeUnlocked, isOtpSet, isOtpAuthenticated } = await import("./security.js");
            return jsonResponse({
                locked: isSurfaceLocked(this.settings, DASHBOARD_SCOPE),
                scope: DASHBOARD_SCOPE,
                pinSet: isSecurityPinSet(this.settings),
                unlocked: isScopeUnlocked(DASHBOARD_SCOPE),
                otpSet: isOtpSet(this.settings),
                otpAuthenticated: isOtpAuthenticated(DASHBOARD_SCOPE),
            });
        }

        return jsonResponse({ error: `Not found: ${req.method} ${pathname}` }, 404);
    }

    start(port = DASHBOARD_DEFAULT_PORT) {
        if (this.server) return this.server;
        const resolved = Number(port) || DASHBOARD_DEFAULT_PORT;
        this.port = resolved;
        const self = this;
        try {
            this.server = Bun.serve({
                port: resolved,
                hostname: BIND_HOST,
                fetch: (req) => self.handleRequest(req),
            });
            console.log("=========================================================================");
            console.log(`📊 Dagowan Dashboard (OpenWebUI-style): http://127.0.0.1:${resolved}`);
            console.log(`📡 API health: http://127.0.0.1:${resolved}/api/health`);
            console.log("=========================================================================");
        } catch (err) {
            console.error("⚠️ Failed to start Dashboard server:", err.message);
        }
        return this.server;
    }

    stop() {
        if (this.server) {
            try {
                this.server.stop();
            } catch {}
            this.server = null;
            console.log("🛑 Dashboard server stopped.");
        }
    }
}
