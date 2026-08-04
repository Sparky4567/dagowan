import { logPrompt } from "./src/logger.js";
import ollama from "ollama";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import fs from "node:fs";
import path from "node:path";

import { loadSettings, saveSettings } from "./src/config.js";
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
import { formatActiveTasks, TaskReminderManager } from "./src/tasks.js";
import { AgenticModule } from "./src/agentic.js";
import { COMMANDS_HELP, handleSlashCommand } from "./src/commands.js";
import { TelegramBotRunner, startAllTelegramBots } from "./src/telegram.js";
import { WhatsAppBridgeServer } from "./src/whatsapp.js";
import { unifiedChat } from "./src/providers.js";
import { synthesizeSpeechLocal } from "./src/audio.js";
import { LocalVoiceSocketBridge } from "./src/voice_socket.js";
import { ProactiveChatManager } from "./src/proactive.js";

async function main() {
    // 1. Load configuration and data
    const settings = loadSettings();
    const characterStore = loadCharacterStore("characters.json", settings.model, settings.system_template);
    const activeChar = getActiveCharacter(characterStore);

    // Sync settings with active character
    settings.active_character = activeChar.id;
    if (activeChar.model) {
        settings.model = activeChar.model;
    }
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

    const context = {
        settings,
        characterStore,
        activeSessionId: activeSession.id,
        messages: activeSession.messages || [],
        taskReminderManager,
        proactiveManager,
    };

    const rl = readline.createInterface({ input, output });

    console.log("\n=======================================================");
    console.log("🦙 Welcome to Llama Chat CLI (Bun / m-edit toolsuite)");
    console.log(`🎭 Active Persona: "${activeChar.name}" (${activeChar.id})`);
    console.log(`🤖 Active Model: "${context.settings.model}"`);
    console.log("-------------------------------------------------------");

    // 4. Start Telegram, WhatsApp, and Voice Socket bridges if configured
    let tgRunners = await startAllTelegramBots({ characterStore, settings, proactiveManager });

    let waServer = null;
    if (process.argv.includes("--whatsapp") || settings.whatsapp_enabled) {
        waServer = new WhatsAppBridgeServer({ characterStore, settings, proactiveManager });
        await waServer.start(8765);
    } else {
        console.log("📱 WhatsApp Bridge: Disabled");
    }

    let voiceBridge = null;
    if (process.argv.includes("--web") || process.argv.includes("--voice-server") || process.argv.includes("--dagowan") || settings.web_enabled || settings.voice_server_enabled) {
        voiceBridge = new LocalVoiceSocketBridge({ settings, characterStore });
        voiceBridge.start(8767);
    } else {
        console.log("🌐 Dagowan Voice Web Bridge: Disabled (Launch with --web or /web)");
    }

    console.log("-------------------------------------------------------");
    console.log("Type /help to view all slash commands & options.");
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

        // Basic exit command
        if (userInput.trim().toLowerCase() === "exit" || userInput.trim().toLowerCase() === "quit") {
            saveSession(context.activeSessionId, context.messages, getActiveCharacter(context.characterStore).id);
            taskReminderManager.stop();
            proactiveManager.stop();
            if (Array.isArray(tgRunners)) tgRunners.forEach((r) => r.stop());
            if (waServer) waServer.stop();
            console.log("👋 Session saved. Goodbye!");
            rl.close();
            process.exit(0);
        }

        // Basic clear command
        if (userInput.trim().toLowerCase() === "/clear") {
            context.messages = [];
            saveSession(context.activeSessionId, context.messages, getActiveCharacter(context.characterStore).id);
            console.log("🧹 Active conversation context cleared.");
            continue;
        }

        // Check Agentic Tool triggers (search YouTube, Google, Giphy, open browser)
        const agenticResult = agentic.selectTool(userInput);
        if (agenticResult.handled) {
            console.log(agenticResult.message);
            continue;
        }

        // Check Slash Commands
        let compiledPrompt = null;
        if (userInput.startsWith("/")) {
            const cmdResult = await handleSlashCommand({
                commandStr: userInput,
                context,
                ollamaClient: ollama,
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

        // Add user message to session transcript
        context.messages.push({
            role: "user",
            content: userInput,
        });

        // Assemble model messages array with rich context injection
        const modelMessages = [];

        // 1. System Prompt from Active Character Profile
        const systemPromptText = composeSystemTemplate(getActiveCharacter(context.characterStore));
        if (systemPromptText) {
            modelMessages.push({
                role: "system",
                content: systemPromptText,
            });
        }

        // 2. Retrieve relevant memories matching query
        const relevantMemories = retrieveMemories(queryText, 5);
        if (relevantMemories.length > 0) {
            modelMessages.push({
                role: "system",
                content: `[Relevant Persistent Memories]:\n${relevantMemories.map((m) => `• ${m}`).join("\n")}`,
            });
        }

        // 3. Retrieve relevant session context from other past sessions
        const pastContext = retrieveSessionContext(queryText, context.activeSessionId, 3);
        if (pastContext.length > 0) {
            const formattedContext = pastContext
                .map((item) => `[From "${item.session_title}"] ${item.role}: ${item.content}`)
                .join("\n");
            modelMessages.push({
                role: "system",
                content: `[Relevant Past Conversation Context]:\n${formattedContext}`,
            });
        }

        // 4. Inject active Kanban tasks if user query is related to tasks/kanban/todo
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

        // 5. Append recent conversation history from current session
        const historyWindow = context.messages.slice(-settings.mem_limit * 2);
        for (const msg of historyWindow) {
            modelMessages.push(msg);
        }

        // If a compiled prompt was created (e.g. via /write-about), override the last user message in payload
        if (compiledPrompt && modelMessages.length > 0) {
            modelMessages[modelMessages.length - 1] = {
                role: "user",
                content: compiledPrompt,
            };
        }

        process.stdout.write("\nAssistant: ");
        let assistantReply = "";

        try {
            const res = await unifiedChat({
                modelName: context.settings.model,
                messages: modelMessages,
                stream: true,
                settings: context.settings,
                ollamaClient: ollama,
                onChunk: (chunkText) => {
                    assistantReply += chunkText;
                    process.stdout.write(chunkText);
                },
            });

            console.log("\n");

            context.messages.push({
                role: "assistant",
                content: assistantReply || res.content || "",
            });

            // Save session after every exchange
            saveSession(context.activeSessionId, context.messages, activeChar.id);

            // Synthesize local speech response if enabled
            if (context.settings.voice_reply_enabled && (assistantReply || res.content)) {
                try {
                    const voiceOut = path.join(process.cwd(), "pdfs", `voice_reply_${Date.now()}.wav`);
                    const ttsResult = await synthesizeSpeechLocal(assistantReply || res.content, voiceOut);
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
