import { logPrompt } from "./src/logger.js";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import fs from "node:fs";
import path from "node:path";

import { loadSettings, saveSettings } from "./src/config.js";
import { getNeuromorphicMemory } from "./src/neuromorphic_memory.js";
import {
    loadCharacterStore,
    getActiveCharacter,
    composeSystemTemplate,
} from "./src/characters.js";
import {
    loadSession,
    createSession,
    saveSession,
    listSessions,
    retrieveSessionContext,
} from "./src/sessions.js";
import { loadMemories, retrieveMemories, saveMemories } from "./src/memory.js";
import { retrieveKnowledge } from "./src/knowledge.js";
import { retrieveChatContextParallel } from "./src/chat_context.js";
import { summarizeMessages } from "./src/context_budget.js";
import { buildUserProfileBlock } from "./src/personalization.js";
import { selectModelForTask } from "./src/model_router.js";
import { getLearningPipeline } from "./src/learning.js";
import { formatActiveTasks, TaskReminderManager } from "./src/tasks.js";
import { AgenticModule } from "./src/agentic.js";
import { COMMANDS_HELP, handleAtCommand as handleSlashCommand } from "./src/commands.js";
import { detectBlogIntent } from "./src/blog_api.js";
import { TelegramBotRunner, startAllTelegramBots } from "./src/telegram.js";
import { PersonaPollingBridge, isPersonaOnDemandEnabled } from "./src/persona_bridge.js";
import { findMentionedCharacters } from "./src/whatsapp_mentions.js";
import { WhatsAppBridgeServer, shouldStartWhatsApp } from "./src/whatsapp.js";
import { unifiedChat } from "./src/providers.js";
import { synthesizeSpeechLocal } from "./src/audio.js";
import { LocalVoiceSocketBridge } from "./src/voice_socket.js";
import { DashboardServer, shouldStartDashboard, shouldStartAvatar, shouldStartAiFriend, shouldStartAiFriendDash, resolveDashboardPort } from "./src/dashboard.js";
import { ProactiveChatManager } from "./src/proactive.js";
import { initializeSharedModel, getSharedModel, setSharedModel } from "./src/model_selection.js";
import { tryNeedleFastPath, stopNeedleDaemon } from "./src/needle.js";
import { stopMcpManager } from "./src/mcp.js";
import {
    CLI_SCOPE,
    isOtpCommand,
    isProbablyControlCommand,
    isSecurityCommand,
    isSurfaceLocked,
    lockedMessage,
} from "./src/security.js";
import {
    appendSimulationExchange,
    buildSimulationSystemPrompt,
    cliScopeKey,
    extractSimulationHeuristic,
    formatSimulationArchiveBlock,
    getActiveSimulation,
    searchSimulation,
} from "./src/simulation.js";

async function main() {
    // MCP server mode: expose Dagowan as an MCP server (stdio + HTTP) and
    // skip the interactive CLI REPL.
    if (process.argv.includes("--mcp") || process.argv.includes("--mcp-stdio-only") || process.argv.includes("--mcp-http-only")) {
        const { startMcpServer } = await import("./src/mcp_server.js");
        const httpOnly = process.argv.includes("--mcp-http-only");
        const stdioOnly = process.argv.includes("--mcp-stdio-only");
        await startMcpServer({
            http: !stdioOnly,
            stdio: !httpOnly,
        });
        // Keep the process alive (HTTP server / stdin handle do this, but be safe).
        await new Promise(() => {});
        return;
    }

    // 1. Load configuration and data
    const settings = loadSettings();
    // Configure the shared Neuromorphic Cognitive Memory singleton from settings
    // so every surface (CLI / Telegram / WhatsApp / voice / dashboard) uses the
    // same enabled state and plasticity parameters.
    try { getNeuromorphicMemory().applySettings(settings); } catch {}

    // Docker / env override: OLLAMA_HOST, OLLAMA_URL or OLLAMA_BASE_URL wins over
    // stored settings so the container can point at a host-side or compose Ollama.
    const ollamaHostEnv = process.env.OLLAMA_HOST || process.env.OLLAMA_URL || process.env.OLLAMA_BASE_URL;
    if (ollamaHostEnv && ollamaHostEnv !== settings.server_url) {
        settings.server_url = ollamaHostEnv;
        saveSettings(settings);
    }

    // Auto-detect bun-ollama (ollama-lite) server URL from its runtime PID file.
    // This keeps server_url correct even if the server was started on a non-default port.
    const pidFilePath = path.join(
        process.env.HOME || process.env.USERPROFILE || "~",
        ".ollama-lite", "runtime", "server.pid"
    );
    if (fs.existsSync(pidFilePath)) {
        try {
            const pidData = JSON.parse(fs.readFileSync(pidFilePath, "utf8"));
            const host = pidData.host === "0.0.0.0" || pidData.host === "::" ? "127.0.0.1" : (pidData.host || "127.0.0.1");
            const port = pidData.port || 11434;
            const detectedUrl = `http://${host}:${port}`;
            if (detectedUrl !== settings.server_url) {
                console.log(`🔗 Auto-detected bun-ollama server at ${detectedUrl} (was: ${settings.server_url})`);
                settings.server_url = detectedUrl;
                saveSettings(settings);
            }
        } catch {
            // PID file unreadable — keep whatever is in settings
        }
    }

    // Re-create the top-level ollama client pointed at the detected server URL.
    const { Ollama } = await import("ollama");
    const ollamaClient = new Ollama({ host: settings.server_url });

    await initializeSharedModel(settings, ollamaClient);
    const characterStore = loadCharacterStore("characters.json", settings.model, settings.system_template);
    const activeChar = getActiveCharacter(characterStore);

    // Sync settings with active character
    settings.active_character = activeChar.id;
    await setSharedModel(settings, characterStore, getSharedModel(settings));
    saveSettings(settings);

    // 2. Initialize active chat session
    const sessions = listSessions(activeChar.id);
    let activeSession = sessions.length > 0 ? sessions[0] : createSession(activeChar.id);

    // 3. Initialize Agentic module, task reminder manager & proactive chat manager
    const agentic = new AgenticModule();
    const taskReminderManager = new TaskReminderManager((reminderText) => {
        console.log(`\n\n⏰ [BACKGROUND REMINDER]\n${reminderText}\n`);
    }, settings);
    if (settings.task_reminder_enabled) {
        taskReminderManager.start(settings.task_reminder_minutes || 15);
    }

    const proactiveManager = new ProactiveChatManager({
        settings,
        callback: async ({ chatKey, idleMinutes }) => {
            console.log(`\n\n⏱ [PROACTIVE CHECK-IN] User inactive for ${idleMinutes} minute(s) in session (${chatKey}).\n`);
        },
    });
    if (settings.proactive_chat_enabled) {
        proactiveManager.startTimer();
    }

    const learningPipeline = getLearningPipeline();

    const context = {
        settings,
        characterStore,
        activeSessionId: activeSession.id,
        messages: activeSession.messages || [],
        taskReminderManager,
        proactiveManager,
        learningPipeline,
        personaBridge: null,
    };

    const rl = readline.createInterface({ input, output });

    console.log("\n=======================================================");
    console.log("🦙 Welcome to Llama Chat CLI (Bun / m-edit toolsuite)");
    console.log(`🎭 Active Persona: "${activeChar.name}" (${activeChar.id})`);
    console.log(`🤖 Active Model: "${context.settings.model}"`);
    console.log("-------------------------------------------------------");

    // 4. Start Telegram (on-demand persona polling bridge), WhatsApp, and Voice Socket bridges.
    // Only the ACTIVE persona polls from the start; other personas wake on
    // explicit request (@character switch, @wake, @Name mention routing) and
    // auto-sleep after persona_idle_timeout_minutes of inactivity.
    if (settings.persona_idle_timeout_minutes === undefined) settings.persona_idle_timeout_minutes = 15;
    if (settings.persona_polling_on_demand === undefined) settings.persona_polling_on_demand = true;
    const personaBridge = new PersonaPollingBridge({ characterStore, settings, proactiveManager });
    if (isPersonaOnDemandEnabled(settings)) {
        await personaBridge.startActiveOnly();
    } else {
        await personaBridge.startAll();
    }
    personaBridge.startIdleSweeper();
    context.personaBridge = personaBridge;

    let waServer = null;
    const waDecision = shouldStartWhatsApp(settings, process.argv, process.env);
    if (waDecision.start) {
        const waPort = Number(process.env.WHATSAPP_PORT || 8765);
        const waStatusPort = Number(process.env.WHATSAPP_STATUS_PORT || 8766);
        waServer = new WhatsAppBridgeServer({ port: waPort, statusPort: waStatusPort, characterStore, settings, proactiveManager, personaBridge });
        await waServer.start();
    } else if (waDecision.reason === "not-configured") {
        console.log("📱 WhatsApp Bridge: Disabled (not configured — set @set-whatsapp-phone <number> or link once, then @whatsapp-enabled on; start on demand with --whatsapp)");
    } else {
        console.log("📱 WhatsApp Bridge: Disabled");
    }

    let voiceBridge = null;
    if (process.argv.includes("--web") || process.argv.includes("--voice-server") || process.argv.includes("--dagowan") || settings.web_enabled || settings.voice_server_enabled) {
        const webPort = Number(process.env.VOICE_PORT || process.env.WEB_PORT || 8767);
        voiceBridge = new LocalVoiceSocketBridge({ settings, characterStore });
        voiceBridge.start(webPort);
    } else {
        console.log("🌐 Dagowan Voice Web Bridge: Disabled (Launch with --web or @web)");
    }

    let dashboardServer = null;
    const dashDecision = shouldStartDashboard(settings, process.argv, process.env);
    const avatarDecision = shouldStartAvatar(settings, process.argv, process.env);
    const aiFriendDecision = shouldStartAiFriend(settings, process.argv, process.env);
    const aiFriendDashDecision = shouldStartAiFriendDash(settings, process.argv, process.env);
    if (avatarDecision.enabled) {
        settings.avatar_enabled = true;
        try { saveSettings(settings); } catch {}
    }
    if (aiFriendDecision.enabled) {
        settings.aifriend_enabled = true;
        try { saveSettings(settings); } catch {}
    }
    if (aiFriendDashDecision.enabled) {
        settings.aifrienddash_enabled = true;
        try { saveSettings(settings); } catch {}
    }
    if (dashDecision.start) {
        const dashPort = resolveDashboardPort(settings, process.argv, process.env);
        dashboardServer = new DashboardServer({ settings, characterStore });
        dashboardServer.start(dashPort);
        if (avatarDecision.enabled) {
            console.log(`👄 Avatar popup: http://127.0.0.1:${dashPort}/avatar (dashboard voice only)`);
        } else {
            console.log("👄 Avatar: Disabled (launch with --avatar to enable the lipsync popup)");
        }
        if (aiFriendDecision.enabled) {
            console.log(`🤖 AI Friend popup (AI Bud Pro avatar): http://127.0.0.1:${dashPort}/aifriend (dashboard voice only)`);
        } else {
            console.log("🤖 AI Friend: Disabled (launch with --aifriend to enable the AI Bud Pro avatar)");
        }
        if (aiFriendDashDecision.enabled) {
            console.log(`🤖💬 AI Friend dashboard (AI Bud Pro chat): http://127.0.0.1:${dashPort}/aifrienddash`);
        } else {
            console.log("🤖💬 AI Friend dashboard: Disabled (launch with --aifrienddash to enable the AI Bud Pro chat)");
        }
    } else if (dashDecision.reason === "disabled-flag" || dashDecision.reason === "disabled-env") {
        console.log("📊 Dashboard: Disabled");
    } else {
        console.log("📊 Dashboard: Disabled (Launch with --dashboard or -dashboard, port 8768 by default)");
    }

    console.log("-------------------------------------------------------");
    console.log("Type @help to view all @ commands & options.");
    console.log("=======================================================\n");

    while (true) {
        const promptLabel = `\n[${getActiveCharacter(context.characterStore).name} | ${context.settings.model}] > `;
        let userInput = "";
        try {
            userInput = await rl.question(promptLabel);
        } catch {
            break;
        }

        if (!userInput.trim()) continue;

        logPrompt(userInput, "cli");
        proactiveManager.recordActivity("cli");

        // On-demand persona wake: "@Name ..." routes polling to that persona
        // without switching the active one (same rule as WhatsApp mentions).
        try {
            const mentioned = findMentionedCharacters(userInput, (characterStore && characterStore.characters) || []);
            if (mentioned.length > 0) {
                for (const m of mentioned) {
                    await personaBridge.ensurePersona(m.id, "cli-mention");
                }
            } else {
                personaBridge.recordActivity(getActiveCharacter(characterStore)?.id);
            }
        } catch {}

        // Basic exit command
        if (userInput.trim().toLowerCase() === "exit" || userInput.trim().toLowerCase() === "quit") {
            saveSession(context.activeSessionId, context.messages, getActiveCharacter(context.characterStore).id);
            taskReminderManager.stop();
            proactiveManager.stop();
            try { stopNeedleDaemon(); } catch {}
            try { stopMcpManager(); } catch {}
            await personaBridge.stopAll();
            if (waServer) waServer.stop();
            if (voiceBridge) voiceBridge.stop();
            if (dashboardServer) dashboardServer.stop();
            console.log("👋 Session saved. Goodbye!");
            rl.close();
            process.exit(0);
        }

        // Basic clear command (@clear canonical, /clear still accepted)
        const trimmedLower = userInput.trim().toLowerCase();
        if (trimmedLower === "@clear" || trimmedLower === "/clear") {
            if (isSurfaceLocked(settings, CLI_SCOPE)) {
                console.log(`\n${lockedMessage(settings, CLI_SCOPE)}\n`);
                continue;
            }
            context.messages = [];
            saveSession(context.activeSessionId, context.messages, getActiveCharacter(context.characterStore).id);
            console.log("🧹 Active conversation context cleared.");
            continue;
        }

        // Security PIN + OTP pre-gate: while locked, control commands (except
        // @set-security-pin/@unlock/@lock/@security-status /
        // @otp-* family, which handle themselves) are refused up front, including
        // @help/@commands/@get-commands. Regular
        // chatting — including "@Name" persona mentions — passes through.
        const cliLocked = isSurfaceLocked(settings, CLI_SCOPE);
        if (cliLocked) {
            const t = userInput.trim();
            const probe = t.startsWith("@") ? "/" + t.slice(1) : t;
            const pl = probe.toLowerCase();
            if (!isSecurityCommand(pl) && !isOtpCommand(pl) &&
                (isProbablyControlCommand(t, (characterStore && characterStore.characters) || []) ||
                    detectBlogIntent(t))) {
                console.log(`\n${lockedMessage(settings, CLI_SCOPE)}\n`);
                continue;
            }
        }

        // Check Agentic Tool triggers (search YouTube, Google, Giphy, open browser)
        const agenticResult = agentic.selectTool(userInput);
        if (agenticResult.handled) {
            console.log(agenticResult.message);
            continue;
        }

        // Check @ Commands (MCP-style; leading "/" still accepted for backward compatibility).
        // Natural blog callouts ("write a blog post about ... on @blogger")
        // also route here.
        let compiledPrompt = null;
        if (userInput.startsWith("@") || userInput.startsWith("/") || detectBlogIntent(userInput)) {
            const cmdResult = await handleSlashCommand({
                commandStr: userInput,
                context,
                ollamaClient: ollamaClient,
            });

            if (cmdResult.handled) {
                if (cmdResult.compiledPrompt) {
                    compiledPrompt = cmdResult.compiledPrompt;
                } else {
                    continue;
                }
            }
        }

        // Prepare message content (either compiled note prompt or direct user input)
        const queryText = compiledPrompt || userInput;
        const activeCharNow = getActiveCharacter(context.characterStore);
        const activeCharIdNow = activeCharNow ? activeCharNow.id : activeChar.id;

        // Simulation mode: simple separate chat thread, same persona.
        // Chats + memories go to the simulation archive file.
        const simScope = cliScopeKey(activeCharIdNow);
        let activeSim = null;
        try { activeSim = getActiveSimulation(simScope); } catch { activeSim = null; }

        // Needle on-device fast-path: local-action turns (remember / task /
        // note / timer) are owned by the 8-29 MB model without waking the
        // main LLM. Handled turns skip heuristic + LLM + background learn
        // (the executor already stored the canonical entries).
        // Inside a simulation the fast-path is skipped so turns stay local.
        if (!compiledPrompt && !activeSim) {
            try {
                const fastPath = await tryNeedleFastPath(userInput, context);
                if (fastPath && fastPath.handled) {
                    console.log(`\nAssistant: ${fastPath.reply}\n`);
                    context.messages.push({ role: "user", content: userInput });
                    context.messages.push({ role: "assistant", content: fastPath.reply });
                    saveSession(context.activeSessionId, context.messages, activeCharIdNow);
                    continue;
                }
            } catch {}
        }

        // Run fast heuristic extraction immediately on user turn (scoped to active character).
        // Inside a simulation this is deferred to the simulation archive (see below).
        if (!activeSim) {
            learningPipeline.extractHeuristic(userInput, activeCharIdNow);
        }

        // Add user message to session transcript (main session stays clean
        // while a simulation is active — sim turns live in the archive).
        if (!activeSim) {
            context.messages.push({
                role: "user",
                content: userInput,
            });
        }

        // Assemble model messages array with rich context injection
        const modelMessages = [];

        // 1. System Prompt from Active Character Profile (+ simulation frame)
        const systemPromptText = composeSystemTemplate(getActiveCharacter(context.characterStore));
        if (systemPromptText) {
            modelMessages.push({
                role: "system",
                content: systemPromptText,
            });
        }
        if (activeSim) {
            modelMessages.push({
                role: "system",
                content: buildSimulationSystemPrompt(activeCharNow?.name || activeCharIdNow, activeSim),
            });
        } else {
            const profileBlock = buildUserProfileBlock(activeCharIdNow);
            if (profileBlock) {
                modelMessages.push({ role: "system", content: profileBlock });
            }
        }

        // 2-4. Retrieve memories + knowledge + past sessions in parallel.
        // DB/file reads stay on main thread; CPU scoring fans out to
        // worker_threads with sync fallback (see src/chat_context.js).
        let relevantMemories = [];
        let relevantKnowledge = [];
        let pastContext = [];
        let simArchives = [];
        let reflectionHits = [];
        let turnLanguage = null;
        let bridgeHits = 0;
        try {
            const ctx = await retrieveChatContextParallel(queryText, {
                characterId: activeCharIdNow,
                excludeSessionId: context.activeSessionId,
                memoryLimit: 5,
                knowledgeLimit: 4,
                sessionLimit: 3,
                simulationLimit: 3,
                excludeSimulationSlug: activeSim?.slug || null,
                reflectionLimit: 3,
            });
            relevantMemories = ctx.memories;
            relevantKnowledge = ctx.knowledge;
            pastContext = ctx.pastContext;
            simArchives = ctx.simulations || [];
            reflectionHits = ctx.reflections || [];
            turnLanguage = ctx.language || null;
            bridgeHits = ctx.bridgeHits || 0;
        } catch {
            relevantMemories = retrieveMemories(queryText, 5, undefined, activeCharIdNow);
            relevantKnowledge = retrieveKnowledge(queryText, 4);
            pastContext = retrieveSessionContext(queryText, context.activeSessionId, 3, activeCharIdNow);
        }
        if (turnLanguage) {
            const { buildLanguageScopeNote } = await import("./src/language.js");
            const note = buildLanguageScopeNote(turnLanguage, bridgeHits);
            if (note) modelMessages.push({ role: "system", content: note });
        }
        if (relevantMemories.length > 0) {
            modelMessages.push({
                role: "system",
                content: `[Relevant Persistent Memories]:\n${relevantMemories.map((m) => `• ${m}`).join("\n")}`,
            });
        }

        // 2b. Simulation-local memories (active sim) — ranked within archive.
        if (activeSim) {
            try {
                const local = searchSimulation(queryText, activeSim.slug, { limit: 5 });
                const localTexts = local
                    .filter((h) => h.kind === "memory")
                    .map((h) => h.memory.content);
                if (localTexts.length > 0) {
                    modelMessages.push({
                        role: "system",
                        content: `[Simulation "${activeSim.name}" Memories]:\n${localTexts.map((m) => `• ${m}`).join("\n")}`,
                    });
                }
            } catch {}
        }

        // 2c. Cross-simulation association recall (archived what-ifs).
        if (simArchives.length > 0) {
            modelMessages.push({
                role: "system",
                content: formatSimulationArchiveBlock(simArchives),
            });
        }

        // 2d. Daily self-reflections (own past insights, association recall).
        if (reflectionHits.length > 0) {
            try {
                const { formatReflectionBlock } = await import("./src/reflections.js");
                const block = formatReflectionBlock(reflectionHits);
                if (block) modelMessages.push({ role: "system", content: block });
            } catch {}
        }

        // 3. Retrieve relevant knowledge base concepts matching query
        if (relevantKnowledge.length > 0) {
            modelMessages.push({
                role: "system",
                content: `[Relevant Knowledge Base]:\n${relevantKnowledge.map((k) => `• [${k.knowledge.title} (${k.knowledge.category})]: ${k.knowledge.content}`).join("\n")}`,
            });
        }

        // 4. Retrieve relevant session context from other past sessions (scoped to active character)
        if (pastContext.length > 0) {
            const formattedContext = pastContext
                .map((item) => `[From "${item.session_title}"] ${item.role}: ${item.content}`)
                .join("\n");
            modelMessages.push({
                role: "system",
                content: `[Relevant Past Conversation Context]:\n${formattedContext}`,
            });
        }

        // 5. Inject active Kanban tasks if user query is related to tasks/kanban/todo
        const lowerInput = userInput.toLowerCase();
        if (
            lowerInput.includes("task") ||
            lowerInput.includes("kanban") ||
            lowerInput.includes("todo") ||
            lowerInput.includes("progress")
        ) {
            const tasksSummary = formatActiveTasks();
            modelMessages.push({
                role: "system",
                content: `[Current Active Tasks Context]:\n${tasksSummary}`,
            });
        }

        // 5b. Live web search: "@live-web" / "@live-gemini" anywhere in the sentence triggers a
        // real-time search whose results are injected as system context, so
        // EVERY provider (local Ollama + OpenAI/Gemini/Claude/Grok/Mistral cloud
        // models via unifiedChat) answers with current facts. "@web" is the
        // voice-bridge toggle and never reaches here
        // (owned by handleSlashCommand above).
        try {
            const { runWebSearchForPrompt } = await import("./src/websearch.js");
            const webHit = await runWebSearchForPrompt(queryText, context.settings);
            if (webHit.triggered && webHit.block) {
                console.log(`\n🌐 [live web: ${webHit.searchRes.provider}] "${webHit.query}" → ${webHit.searchRes.results.length} result(s)\n`);
                modelMessages.push({ role: "system", content: webHit.block });
            } else if (webHit.triggered && !webHit.block) {
                console.log(`\n⚠️ Live web search found nothing: ${webHit.searchRes.error || "no results"}\n`);
            }
        } catch {}

        // 5c. Conversation summary: compact older turns so long chats don't
        // overflow the context window while keeping recent turns verbatim.
        if (!activeSim && Array.isArray(context.messages) && context.messages.length > settings.mem_limit * 2) {
            const older = context.messages.slice(0, -settings.mem_limit * 2);
            const summary = summarizeMessages(older);
            if (summary) {
                modelMessages.push({ role: "system", content: `[Conversation summary (older turns)]:\n${summary}` });
            }
        }

        // 6. Append recent conversation history: simulation archive while
        // active (isolated), otherwise current session.
        // NOTE: context.messages already contains the current user turn in
        // the non-sim path (pushed above), but the sim archive only holds
        // *previous* turns (current turn is appended after the LLM call).
        // So the current query must be pushed explicitly here — otherwise
        // the model answers stale history and every other turn comes back
        // empty (just "🎭 [sim:...] archived.").
        if (activeSim) {
            const simHistory = (activeSim.messages || []).slice(-settings.mem_limit * 2);
            for (const msg of simHistory) {
                if (msg.role === "user" || msg.role === "assistant") {
                    modelMessages.push({ role: msg.role, content: msg.content });
                }
            }
            modelMessages.push({ role: "user", content: queryText });
        } else {
            const historyWindow = context.messages.slice(-settings.mem_limit * 2);
            for (const msg of historyWindow) {
                modelMessages.push(msg);
            }
        }

        // If a compiled prompt was created (e.g. via @write-about), override the last user message in payload
        if (compiledPrompt && modelMessages.length > 0) {
            modelMessages[modelMessages.length - 1] = {
                role: "user",
                content: compiledPrompt,
            };
        }

        const selectedModel = selectModelForTask(context.settings, queryText, {
            needleEnabled: Boolean(context.settings.needle_enabled),
            needleHandled: false,
        });
        if (selectedModel && selectedModel !== context.settings.model) {
            console.log(`\n🧭 [model router] ${context.settings.model} → ${selectedModel}\n`);
        }
        process.stdout.write("\nAssistant: ");
        let assistantReply = "";

        try {
            const res = await unifiedChat({
                modelName: selectedModel || context.settings.model,
                messages: modelMessages,
                stream: true,
                settings: context.settings,
                ollamaClient: ollamaClient,
                onChunk: (chunkText) => {
                    assistantReply += chunkText;
                    process.stdout.write(chunkText);
                },
            });

            console.log("\n");

            const finalReply = (assistantReply || res.content || "").trim();
            if (activeSim) {
                // Simulation turn stays inside the archive (not global memory).
                try {
                    appendSimulationExchange(activeSim.slug, userInput, finalReply);
                    extractSimulationHeuristic(activeSim.slug, userInput);
                } catch {}
                if (!finalReply) {
                    console.log(`\n⚠️ LLM returned an empty reply — "${userInput}" was still archived to [sim:${activeSim.name}]. Try again or check Ollama/model status.\n`);
                } else {
                    console.log(`\n🎭 [sim:${activeSim.name}] archived.\n`);
                }
            } else {
                context.messages.push({
                    role: "assistant",
                    content: finalReply,
                });

                // Save session after every exchange (enforce active character ownership)
                saveSession(context.activeSessionId, context.messages, activeCharIdNow);

                // Trigger background incremental learning extraction (scoped to active character)
                if (context.settings.auto_learning_enabled !== false) {
                    const historyContext = context.messages.slice(-6).map((m) => `${m.role}: ${m.content}`).join("\n");
                    learningPipeline.extractWithLLM(userInput, finalReply, historyContext, {
                        settings: context.settings,
                        ollamaClient: ollamaClient,
                        characterId: activeCharIdNow,
                    }).catch(() => {});
                }

                // Adaptive auto-insight: micro self-observation every N
                // substantive turns (background, never blocks the reply).
                try {
                    const { maybeAutoInsight } = await import("./src/auto_insight.js");
                    maybeAutoInsight({
                        settings: context.settings,
                        characterId: activeCharIdNow,
                        personaName: activeCharNow?.name || activeCharIdNow,
                        userText: userInput,
                        sessionMessages: context.messages,
                        ollamaClient,
                    }).catch(() => {});
                } catch {}
            }

            // Synthesize local speech response if enabled
            if (context.settings.voice_reply_enabled && finalReply) {
                try {
                    const voiceOut = path.join(process.cwd(), "pdfs", `voice_reply_${Date.now()}.wav`);
                    const ttsResult = await synthesizeSpeechLocal(finalReply, voiceOut);
                    console.log(`🔊 [Local Voice Synthesized]: ${ttsResult.audioPath}`);
                } catch (vErr) {
                    console.error("⚠️ Local Voice Synthesis error:", vErr.message);
                }
            }

        } catch (err) {
            console.error("\n⚠️ LLM Chat Error:", err.message || err);
            console.log("");
        }
    }
}

main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});
