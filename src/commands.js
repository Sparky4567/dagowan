import { remember, formatMemories, deleteMemory, updateMemory } from "./memory.js";
import {
    registerTask,
    formatActiveTasks,
    formatAllTasks,
    moveTask,
    deleteTask,
    parseMoveTaskCommand,
    parseDeleteTaskCommand,
} from "./tasks.js";
import { exportSettings, importSettings, listBackups, saveSettings, setSetting } from "./config.js";
import { detectProvider, getApiKey, maskApiKey, DEFAULT_MODELS } from "./providers.js";
import { transcribeAudioLocal, synthesizeSpeechLocal } from "./audio.js";
import { getActiveCharacter, setActiveCharacter, listCharacters, createCharacter, updateCharacterToken, saveCharacterStore } from "./characters.js";
import {
    listSessions,
    loadSession,
    createSession,
    deleteSession,
    renameSession,
    saveSession,
} from "./sessions.js";
import { writeAboutPrompt } from "./workspace.js";
import { convertNotesToPdf, convertPdfToMd } from "./pdf_utils.js";
import { resetWhatsAppAuth, requestWhatsAppPairing } from "./whatsapp.js";
import { LocalVoiceSocketBridge } from "./voice_socket.js";
import { handleProactiveCommand, ProactiveChatManager } from "./proactive.js";

let globalVoiceBridge = null;

export const COMMANDS_HELP = `🤖 Available Commands in Ollama Chat (Bun / m-edit toolsuite):

🎙 Local Voice & Audio Commands (100% Offline Local Models):
• /voice <audio_file_path> — Transcribe voice attachment locally (Whisper STT) & generate answer
• /tts <text> — Synthesize text locally into speech audio (MMS-TTS)
• /voice-reply [on|off] (or /voicereply) — Toggle automatic local voice note response generation (saved to app_settings.json)
• /web [on|off] (or /voice-socket, /voice-server, /dagowan) — Launch/toggle real-time duplex voice web interface (http://127.0.0.1:8767)

📄 PDF Conversion Commands:
• /convert-pdf [from_date] [to_date] (or /pdf 2026-07 2026-08) — Batch convert Markdown notes in date range to PDF files in pdfs/
• /pdf-to-md [filename.pdf] (or /convert-md notes.pdf) — Convert a PDF file back into Markdown notes in notes/

📋 Kanban & Task Management Commands:
• /register-task <description> (or /task <desc>) — Register a new task in Processing status
• /get-tasks (or /tasks) — List all active (unfinished) tasks
• /all-tasks — List all Kanban tasks (including finished)
• /move-task-<id>-(p|o|f) (or /move-task <id> <p|o|f>) — Move task status (p: processing, o: ongoing, f: finished)
• /delete-task-<id> (or /delete-task <id>) — Delete task by ID
• /set-task-reminder <minutes> — Enable automatic task reminders (saved to app_settings.json)
• /stop-task-reminder — Disable task reminders (saved to app_settings.json)
• /task-reminder-status — Show current task reminder settings

⏱ Proactive Chat & Timer Commands:
• /set-proactive-timer <minutes> (or /proactive-timer <mins>) — Set proactive chat idle timer in minutes (saved to app_settings.json)
• /proactive-chat [on|off] (or /proactive [on|off]) — Enable, disable, or toggle proactive chat check-ins
• /proactive-status (or /proactive-timer-status) — View current proactive chat timer & check-in settings
• /stop-proactive-timer (or /stop-proactive) — Disable proactive chat check-ins
• /set-proactive-check <seconds> (or /proactive-check <secs>) — Set background check frequency in seconds (default 60s)

🧠 Memory Commands:
• /remember <text> — Save a memory into memory.json
• /memories (or /list-memories) — List all saved memories
• /delete-memory <id|timestamp> — Delete memory by index or timestamp
• /update-memory <id|timestamp> <text> — Update memory by index or timestamp

🎭 Character Profiles & Persona Commands:
• /model [model-name] — View or switch active LLM model (supports Ollama, Gemini, Claude, Grok, ChatGPT)
• /models — List available models across all providers (Ollama, Gemini, Claude, Grok, OpenAI)
• /set-api-key <provider> <key> (or /set-key <provider> <key>) — Save API key for openai, gemini, claude, or grok to app_settings.json
• /api-keys (or /keys) — List status of configured provider API keys
• /character [name|id] — View or switch active character persona
• /characters — List available character personas (and saved Telegram tokens)
• /create-character <name> | <model> | <prompt> — Create a custom character persona
• /set-telegram-token <token> [character_id] — Save Telegram token to characters.json / app_settings.json
• /set-persona-prompt <prompt> [character_id] — Save persona system prompt template to characters.json
• /whatsapp-pair <phone_number> — Generate 8-digit WhatsApp pairing code for "Link with phone number instead"
• /set-whatsapp-phone <phone_number> (or /whatsapp-number) — Save WhatsApp phone number setting in app_settings.json
• /whatsapp-enabled [on|off] (or /set-whatsapp) — Toggle WhatsApp bridge enabled setting in app_settings.json
• /reset-whatsapp-auth — Reset desynced WhatsApp auth keys & generate new QR / pairing code

💬 Chat Session Commands:
• /sessions — List saved conversation sessions
• /session <id> — Switch to session by ID
• /new-session — Start a fresh conversation session
• /delete-session <id> — Delete session by ID
• /rename-session <title> — Rename active session

💾 Backup & Settings Commands:
• /settings (or /get-settings) — View all current application settings from app_settings.json
• /set-setting <key> <value> — Update and save any setting to app_settings.json
• /set-server-url <url> — Set Ollama server URL and save to app_settings.json
• /set-mem-limit <num> — Set memory context message limit and save to app_settings.json
• /set-workspace <name> — Set active workspace name and save to app_settings.json
• /export-settings [name] (or /backup) — Export settings, prompts, memories, and tasks to backups/
• /import-settings [filename] (or /restore) — Restore app state from backups/
• /list-backups — List available backup files

🔍 Search & Browser Commands:
• /fetch-note-about <topic> (or /write-about <topic>) — Search notes for topic and compile prompt
• /search-youtube-for <query> — Search YouTube in default browser
• /search-google-for <query> — Search Google in default browser
• /search-giphy-for <query> — Search Giphy in default browser
• /open-browser — Open default web browser

ℹ️ General Commands:
• /clear — Clear active conversation context
• /get-commands (or /commands, /help) — Display this list of commands
• exit / quit — Save session and quit
`;

export async function handleSlashCommand({
    commandStr,
    context,
    ollamaClient,
}) {
    const input = commandStr.trim();
    const lower = input.toLowerCase();

    // Help
    if (lower === "/help" || lower === "/commands" || lower === "/get-commands") {
        console.log(`\n${COMMANDS_HELP}`);
        return { handled: true };
    }

    // Proactive Chat Commands
    const proactiveRes = handleProactiveCommand(
        input,
        context ? context.settings : null,
        context ? context.proactiveManager : null
    );
    if (proactiveRes.handled) {
        console.log(`\n${proactiveRes.output}\n`);
        return { handled: true };
    }

    // Memory - /remember
    if (lower.startsWith("/remember ")) {
        const text = input.slice(10).trim();
        if (!text) {
            console.log("⚠️ Please provide text to remember. Usage: /remember <text>");
            return { handled: true };
        }
        remember(text);
        if (context && Array.isArray(context.messages)) {
            context.messages.push({
                role: "system",
                content: `[Persistent Memory Added]: "${text}"`,
            });
            if (context.activeSessionId) {
                saveSession(context.activeSessionId, context.messages);
            }
        }
        console.log(`🧠 Memory saved & assistant context refreshed: "${text}"`);
        return { handled: true };
    }

    // Memory - /memories, /list-memories
    if (lower === "/memories" || lower === "/list-memories") {
        console.log(`\n${formatMemories()}\n`);
        return { handled: true };
    }

    // Memory - /delete-memory
    if (lower.startsWith("/delete-memory ")) {
        const target = input.slice(15).trim();
        const res = deleteMemory(target);
        if (res.success) {
            if (context && Array.isArray(context.messages)) {
                context.messages.push({
                    role: "system",
                    content: `[Persistent Memory Removed]: "${res.removed.text}"`,
                });
                if (context.activeSessionId) {
                    saveSession(context.activeSessionId, context.messages);
                }
            }
            console.log(`🗑 Memory deleted & assistant context refreshed: "${res.removed.text}"`);
        } else {
            console.log(`⚠️ ${res.message}`);
        }
        return { handled: true };
    }

    // Memory - /update-memory
    if (lower.startsWith("/update-memory ")) {
        const parts = input.slice(15).trim().split(/\s+/);
        const target = parts[0];
        const newText = parts.slice(1).join(" ");
        if (!target || !newText) {
            console.log("⚠️ Usage: /update-memory <index|timestamp> <new text>");
            return { handled: true };
        }
        const res = updateMemory(target, newText);
        if (res.success) {
            if (context && Array.isArray(context.messages)) {
                context.messages.push({
                    role: "system",
                    content: `[Persistent Memory Updated]: "${res.memory.text}"`,
                });
                if (context.activeSessionId) {
                    saveSession(context.activeSessionId, context.messages);
                }
            }
            console.log(`✏️ Memory updated & assistant context refreshed: #${target} -> "${res.memory.text}"`);
        } else {
            console.log(`⚠️ ${res.message}`);
        }
        return { handled: true };
    }

    // Tasks - /register-task or /task
    if (lower.startsWith("/register-task ") || lower.startsWith("/task ")) {
        const text = input.startsWith("/register-task ") ? input.slice(15).trim() : input.slice(6).trim();
        if (!text) {
            console.log("⚠️ Usage: /register-task <description>");
            return { handled: true };
        }
        const task = registerTask(text, "p");
        console.log(`📋 Task "#${task.id}" registered into Processing (p) status.`);
        return { handled: true };
    }

    // Tasks - /get-tasks, /tasks
    if (lower === "/get-tasks" || lower === "/tasks") {
        console.log(`\n${formatActiveTasks()}\n`);
        return { handled: true };
    }

    // Tasks - /all-tasks
    if (lower === "/all-tasks") {
        console.log(`\n${formatAllTasks()}\n`);
        return { handled: true };
    }

    // Tasks - Move Task regex: /move-task-1-o or /move-task 1 o
    const moveInfo = parseMoveTaskCommand(input);
    if (moveInfo) {
        const res = moveTask(moveInfo.taskId, moveInfo.status);
        if (res.success) {
            console.log(`📋 Task #${res.task.id} ("${res.task.text}") moved to status ${res.task.status}.`);
        } else {
            console.log(`⚠️ ${res.message}`);
        }
        return { handled: true };
    }

    // Tasks - Delete Task regex: /delete-task-1 or /delete-task 1
    const delTaskId = parseDeleteTaskCommand(input);
    if (delTaskId !== null) {
        const res = deleteTask(delTaskId);
        if (res.success) {
            console.log(`🗑 Task #${res.task.id} ("${res.task.text}") deleted.`);
        } else {
            console.log(`⚠️ ${res.message}`);
        }
        return { handled: true };
    }

    // Tasks Reminders
    if (lower.startsWith("/set-task-reminder ")) {
        const mins = parseInt(input.slice(19).trim(), 10);
        if (isNaN(mins) || mins <= 0) {
            console.log("⚠️ Usage: /set-task-reminder <minutes>");
            return { handled: true };
        }
        context.taskReminderManager.start(mins);
        context.settings.task_reminder_enabled = true;
        context.settings.task_reminder_minutes = mins;
        saveSettings(context.settings);
        console.log(`⏰ Task reminder set for every ${mins} minute(s) and saved to app_settings.json.`);
        return { handled: true };
    }

    if (lower === "/stop-task-reminder") {
        context.taskReminderManager.stop();
        context.settings.task_reminder_enabled = false;
        saveSettings(context.settings);
        console.log("⏰ Task reminders stopped and saved to app_settings.json.");
        return { handled: true };
    }

    if (lower === "/task-reminder-status") {
        const status = context.taskReminderManager.getStatus();
        console.log(`⏰ Task Reminder Status: ${status.enabled ? `Active (every ${status.intervalMinutes}m)` : "Disabled"}`);
        return { handled: true };
    }

    // App Settings Management
    if (lower === "/settings" || lower === "/get-settings" || lower === "/list-settings") {
        console.log("\n⚙️ Current Application Settings (saved in app_settings.json):");
        for (const [k, v] of Object.entries(context.settings)) {
            let valStr = String(v);
            if (k.endsWith("_key") && v) valStr = maskApiKey(v);
            console.log(`  • ${k}: ${valStr}`);
        }
        console.log("\n💡 Change any setting using specific commands or /set-setting <key> <value>\n");
        return { handled: true };
    }

    if (lower.startsWith("/set-setting ")) {
        const parts = input.split(/\s+/);
        const key = parts[1];
        let valStr = parts.slice(2).join(" ");
        if (!key || valStr === undefined || valStr === "") {
            console.log("⚠️ Usage: /set-setting <key> <value>");
            return { handled: true };
        }
        let val = valStr;
        if (valStr === "true") val = true;
        else if (valStr === "false") val = false;
        else if (!isNaN(valStr) && valStr.trim() !== "") val = Number(valStr);

        context.settings[key] = val;
        saveSettings(context.settings);
        console.log(`⚙️ Saved setting "${key}" = ${JSON.stringify(val)} in app_settings.json.`);
        return { handled: true };
    }

    if (lower.startsWith("/set-server-url ") || lower.startsWith("/server-url ")) {
        const url = input.split(/\s+/)[1] || "";
        if (!url) {
            console.log(`🤖 Current Ollama Server URL: ${context.settings.server_url || "http://localhost:11434"}`);
            console.log("⚠️ Usage: /set-server-url <http_url>");
            return { handled: true };
        }
        context.settings.server_url = url;
        saveSettings(context.settings);
        console.log(`🤖 Ollama Server URL saved in app_settings.json: ${url}`);
        return { handled: true };
    }

    if (lower.startsWith("/set-mem-limit ") || lower.startsWith("/mem-limit ")) {
        const num = parseInt(input.split(/\s+/)[1], 10);
        if (isNaN(num) || num <= 0) {
            console.log(`🧠 Current Memory Context Limit: ${context.settings.mem_limit || 10} exchanges`);
            console.log("⚠️ Usage: /set-mem-limit <number_of_messages>");
            return { handled: true };
        }
        context.settings.mem_limit = num;
        saveSettings(context.settings);
        console.log(`🧠 Memory context limit saved in app_settings.json: ${num}`);
        return { handled: true };
    }

    if (lower.startsWith("/set-workspace ") || lower.startsWith("/workspace ")) {
        const wsName = input.split(/\s+/)[1] || "";
        if (!wsName) {
            console.log(`📁 Active Workspace: ${context.settings.active_workspace || "default"}`);
            console.log("⚠️ Usage: /set-workspace <workspace_name>");
            return { handled: true };
        }
        context.settings.active_workspace = wsName;
        saveSettings(context.settings);
        console.log(`📁 Active workspace saved in app_settings.json: "${wsName}"`);
        return { handled: true };
    }

    // Backup / Export
    if (lower.startsWith("/export-settings") || lower.startsWith("/backup")) {
        const parts = input.split(/\s+/);
        const name = parts.length > 1 ? parts[1] : null;
        const backupPath = exportSettings(name);
        console.log(`💾 Backup saved: ${backupPath}`);
        return { handled: true };
    }

    // Restore / Import
    if (lower.startsWith("/import-settings") || lower.startsWith("/restore")) {
        const parts = input.split(/\s+/);
        const file = parts.length > 1 ? parts[1] : null;
        const res = importSettings(file || "");
        if (res.success) {
            console.log(`✅ ${res.message}`);
        } else {
            console.log(`⚠️ ${res.message}`);
        }
        return { handled: true };
    }

    if (lower === "/list-backups") {
        const backups = listBackups();
        if (backups.length === 0) {
            console.log("💾 No backups found in backups/ directory.");
        } else {
            console.log("\n💾 Available Backups:");
            backups.forEach((b, idx) => {
                console.log(`  ${idx + 1}. ${b.filename} (${b.modified_iso}) - ${b.memories_count} memories, ${b.tasks_count} tasks`);
            });
            console.log("");
        }
        return { handled: true };
    }

    // API Keys - /set-api-key <provider> <key>
    if (lower.startsWith("/set-api-key ") || lower.startsWith("/set-key ")) {
        const parts = input.split(/\s+/);
        const provider = (parts[1] || "").toLowerCase();
        const key = parts.slice(2).join(" ").trim();

        if (!provider || !key) {
            console.log("⚠️ Usage: /set-api-key <openai|gemini|claude|grok> <api_key>");
            return { handled: true };
        }

        if (["openai", "chatgpt"].includes(provider)) {
            context.settings.openai_api_key = key;
            saveSettings(context.settings);
            console.log(`🔑 Saved OpenAI (ChatGPT) API Key: ${maskApiKey(key)}`);
        } else if (["gemini", "google"].includes(provider)) {
            context.settings.gemini_api_key = key;
            saveSettings(context.settings);
            console.log(`🔑 Saved Google Gemini API Key: ${maskApiKey(key)}`);
        } else if (["claude", "anthropic"].includes(provider)) {
            context.settings.claude_api_key = key;
            saveSettings(context.settings);
            console.log(`🔑 Saved Anthropic Claude API Key: ${maskApiKey(key)}`);
        } else if (["grok", "xai"].includes(provider)) {
            context.settings.grok_api_key = key;
            saveSettings(context.settings);
            console.log(`🔑 Saved xAI Grok API Key: ${maskApiKey(key)}`);
        } else {
            console.log("⚠️ Unknown provider. Supported providers: openai, gemini, claude, grok");
        }
        return { handled: true };
    }

    // API Keys - /api-keys (list configured keys)
    if (lower === "/api-keys" || lower === "/keys") {
        console.log("\n🔑 Configured Multi-Provider API Keys:");
        const providers = [
            { name: "OpenAI (ChatGPT)", keySetting: context.settings.openai_api_key, envVars: ["OPENAI_API_KEY", "CHATGPT_API_KEY"] },
            { name: "Google Gemini", keySetting: context.settings.gemini_api_key, envVars: ["GEMINI_API_KEY"] },
            { name: "Anthropic Claude", keySetting: context.settings.claude_api_key, envVars: ["CLAUDE_API_KEY", "ANTHROPIC_API_KEY"] },
            { name: "xAI Grok", keySetting: context.settings.grok_api_key, envVars: ["GROK_API_KEY", "XAI_API_KEY"] },
        ];

        providers.forEach((p) => {
            let keySource = "Not Set";
            let masked = "(Not Set)";
            if (p.keySetting) {
                keySource = "app_settings.json";
                masked = maskApiKey(p.keySetting);
            } else {
                for (const ev of p.envVars) {
                    if (process.env[ev]) {
                        keySource = `ENV (${ev})`;
                        masked = maskApiKey(process.env[ev]);
                        break;
                    }
                }
            }
            console.log(`  • ${p.name}: ${masked} [Source: ${keySource}]`);
        });
        console.log("");
        return { handled: true };
    }

    // Models - /models (list local & cloud models across all providers)
    if (lower === "/models") {
        console.log("\n🤖 Available Multi-Provider LLM Models:");

        // 1. Ollama local models
        try {
            const list = await ollamaClient.list();
            console.log("  🦙 Ollama (Local):");
            if (list.models && list.models.length > 0) {
                list.models.forEach((m) => {
                    const mark = m.name === context.settings.model ? " ★ (active)" : "";
                    console.log(`    • ${m.name}${mark}`);
                });
            } else {
                console.log("    (No local Ollama models installed)");
            }
        } catch {
            console.log("  🦙 Ollama (Local): Daemon offline or unreachable");
        }

        // 2. Cloud Providers
        const cloudProviders = [
            { id: "openai", title: "OpenAI ChatGPT", models: DEFAULT_MODELS.openai },
            { id: "gemini", title: "Google Gemini", models: DEFAULT_MODELS.gemini },
            { id: "claude", title: "Anthropic Claude", models: DEFAULT_MODELS.claude },
            { id: "grok", title: "xAI Grok", models: DEFAULT_MODELS.grok },
        ];

        cloudProviders.forEach((p) => {
            const key = getApiKey(p.id, context.settings);
            const status = key ? "configured" : "API key missing";
            console.log(`\n  ⚡ ${p.title} [Status: ${status}]:`);
            p.models.forEach((m) => {
                const mark = m === context.settings.model ? " ★ (active)" : "";
                console.log(`    • ${m}${mark}`);
            });
        });

        console.log("\n💡 Switch active model using: /model <model-name>");
        console.log("💡 Set provider API keys using: /set-api-key <provider> <key>\n");
        return { handled: true };
    }

    // Model - /model
    if (lower === "/model" || lower.startsWith("/model ")) {
        const targetModel = input.slice(6).trim();
        if (!targetModel) {
            const provider = detectProvider(context.settings.model);
            console.log(`🤖 Current Model: ${context.settings.model} (Provider: ${provider})`);
            return { handled: true };
        }
        context.settings.model = targetModel;
        saveSettings(context.settings);
        const provider = detectProvider(targetModel);
        console.log(`🤖 Model updated to: ${targetModel} (Provider: ${provider})`);
        return { handled: true };
    }

    // Characters - /characters
    if (lower === "/characters") {
        const chars = listCharacters(context.characterStore);
        console.log("\n🎭 Character Profiles:");
        chars.forEach((c) => {
            const mark = c.active ? " (active)" : "";
            console.log(`  • [${c.id}] ${c.name} (Model: ${c.model})${mark}`);
        });
        console.log("");
        return { handled: true };
    }

    // Character - /character
    if (lower === "/character" || lower.startsWith("/character ")) {
        const targetChar = input.slice(10).trim();
        if (!targetChar) {
            const active = getActiveCharacter(context.characterStore);
            console.log(`🎭 Active Character: ${active.name} (${active.id}) [Model: ${active.model}]`);
            return { handled: true };
        }
        const res = setActiveCharacter(context.characterStore, targetChar);
        if (res.success) {
            context.settings.active_character = res.activeCharacter.id;
            context.settings.model = res.activeCharacter.model;
            saveSettings(context.settings);
            console.log(`🎭 Switched active character profile to "${res.activeCharacter.name}"`);
        } else {
            console.log(`⚠️ ${res.message}`);
        }
        return { handled: true };
    }

    // Create Character - /create-character Name | Model | Prompt
    if (lower.startsWith("/create-character ")) {
        const payload = input.slice(18).trim();
        const parts = payload.split("|").map((p) => p.trim());
        if (parts.length < 3) {
            console.log("⚠️ Usage: /create-character <Name> | <Model> | <System Prompt>");
            return { handled: true };
        }
        const newChar = createCharacter(parts[0], parts[1], parts[2], {}, context.characterStore);
        console.log(`🎭 Created new character profile "${newChar.name}" (#${newChar.id}).`);
        return { handled: true };
    }

    // Set Telegram Token - /set-telegram-token <token> [character_id]
    if (lower.startsWith("/set-telegram-token ")) {
        const parts = input.slice(20).trim().split(/\s+/);
        const token = parts[0];
        const charId = parts[1] || context.settings.active_character;
        if (!token) {
            console.log("⚠️ Usage: /set-telegram-token <token> [character_id]");
            return { handled: true };
        }
        const res = updateCharacterToken(context.characterStore, charId, token);
        if (res.success) {
            context.settings.telegram_token = token;
            saveSettings(context.settings);
            console.log(`✈️ Saved Telegram Token to characters.json for persona "${res.character.name}" (${res.character.id}) & app_settings.json.`);
        } else {
            console.log(`⚠️ ${res.message}`);
        }
        return { handled: true };
    }

    // Set Persona System Prompt - /set-persona-prompt <prompt> [character_id]
    if (lower.startsWith("/set-persona-prompt ")) {
        const prompt = input.slice(20).trim();
        if (!prompt) {
            console.log("⚠️ Usage: /set-persona-prompt <system prompt text>");
            return { handled: true };
        }
        const activeChar = getActiveCharacter(context.characterStore);
        activeChar.templates = [prompt];
        activeChar.selected_templates = [0];
        saveCharacterStore(context.characterStore);
        context.settings.system_template = prompt;
        saveSettings(context.settings);
        console.log(`🎭 Updated persona system prompt template for "${activeChar.name}" in characters.json & app_settings.json.`);
        return { handled: true };
    }

    // WhatsApp Phone Pairing Code - /whatsapp-pair <phone_number>
    if (lower.startsWith("/whatsapp-pair ")) {
        const phone = input.slice(15).trim();
        if (!phone) {
            console.log("⚠️ Usage: /whatsapp-pair <phone_number_with_country_code> (e.g. /whatsapp-pair 1234567890)");
            return { handled: true };
        }
        console.log(`📱 Requesting WhatsApp pairing code for +${phone.replace(/[^0-9]/g, "")}...`);
        const res = await requestWhatsAppPairing(phone);
        if (res.success) {
            console.log("\n=======================================================");
            console.log(`📱 YOUR WHATSAPP PAIRING CODE: ${res.pairingCode}`);
            console.log("1. Open WhatsApp on phone → Linked Devices → Link a Device");
            console.log('2. Tap "Link with phone number instead"');
            console.log(`3. Enter Code: ${res.pairingCode}`);
            console.log("=======================================================\n");
        } else {
            console.log(`⚠️ ${res.error}`);
        }
        return { handled: true };
    }

    // Set WhatsApp Phone - /set-whatsapp-phone <phone_number>
    if (lower.startsWith("/set-whatsapp-phone ") || lower.startsWith("/whatsapp-number ")) {
        const phone = input.startsWith("/set-whatsapp-phone ") ? input.slice(20).trim() : input.slice(17).trim();
        if (!phone) {
            console.log("⚠️ Usage: /set-whatsapp-phone <phone_number_with_country_code>");
            return { handled: true };
        }
        context.settings.whatsapp_phone = phone.replace(/[^0-9]/g, "");
        saveSettings(context.settings);
        console.log(`📱 WhatsApp phone number saved in app_settings.json: +${context.settings.whatsapp_phone}`);
        return { handled: true };
    }

    // Toggle WhatsApp Bridge Enabled - /whatsapp-enabled [on|off] or /set-whatsapp [on|off]
    if (lower.startsWith("/whatsapp-enabled") || lower.startsWith("/set-whatsapp") || lower === "/whatsapp") {
        const parts = input.split(/\s+/);
        const flag = parts[1] ? parts[1].toLowerCase() : null;
        if (flag === null) {
            context.settings.whatsapp_enabled = !context.settings.whatsapp_enabled;
        } else {
            context.settings.whatsapp_enabled = ["on", "enable", "enabled", "true", "1"].includes(flag);
        }
        saveSettings(context.settings);
        console.log(`📱 WhatsApp bridge status updated: ${context.settings.whatsapp_enabled ? "ENABLED (ON)" : "DISABLED (OFF)"} and saved to app_settings.json.`);
        return { handled: true };
    }

    // Reset WhatsApp Auth - /reset-whatsapp-auth
    if (lower === "/reset-whatsapp-auth") {
        const res = resetWhatsAppAuth();
        console.log(`📱 ${res.message}`);
        return { handled: true };
    }

    // Sessions - /sessions
    if (lower === "/sessions") {
        const activeChar = getActiveCharacter(context.characterStore);
        const sessions = listSessions(activeChar.id);
        if (sessions.length === 0) {
            console.log(`💬 No saved sessions for character "${activeChar.name}".`);
        } else {
            console.log(`\n💬 Saved Sessions for "${activeChar.name}":`);
            sessions.forEach((s) => {
                const mark = s.id === context.activeSessionId ? " (active)" : "";
                console.log(`  • [${s.id.slice(0, 8)}] ${s.title}${mark} (${s.messages.length} msgs)`);
            });
            console.log("");
        }
        return { handled: true };
    }

    // Sessions - /session <id>
    if (lower.startsWith("/session ")) {
        const targetId = input.slice(9).trim();
        const activeChar = getActiveCharacter(context.characterStore);
        const sessions = listSessions(activeChar.id);
        const matched = sessions.find((s) => s.id === targetId || s.id.startsWith(targetId));

        if (!matched) {
            console.log(`⚠️ Session '${targetId}' not found.`);
            return { handled: true };
        }

        context.activeSessionId = matched.id;
        context.messages = matched.messages || [];
        console.log(`💬 Switched to session "${matched.title}" [${matched.id.slice(0, 8)}]`);
        return { handled: true };
    }

    // Sessions - /new-session
    if (lower === "/new-session") {
        const activeChar = getActiveCharacter(context.characterStore);
        const newSession = createSession(activeChar.id);
        context.activeSessionId = newSession.id;
        context.messages = [];
        console.log(`💬 Created fresh chat session [${newSession.id.slice(0, 8)}].`);
        return { handled: true };
    }

    // Sessions - /delete-session
    if (lower.startsWith("/delete-session ")) {
        const targetId = input.slice(16).trim();
        const res = deleteSession(targetId);
        if (res.success) {
            console.log(`🗑 Session [${targetId.slice(0, 8)}] deleted.`);
            if (context.activeSessionId === targetId) {
                const activeChar = getActiveCharacter(context.characterStore);
                const fresh = createSession(activeChar.id);
                context.activeSessionId = fresh.id;
                context.messages = [];
                console.log(`💬 Created replacement session [${fresh.id.slice(0, 8)}].`);
            }
        } else {
            console.log(`⚠️ ${res.message}`);
        }
        return { handled: true };
    }

    // Sessions - /rename-session
    if (lower.startsWith("/rename-session ")) {
        const newTitle = input.slice(16).trim();
        const res = renameSession(context.activeSessionId, newTitle);
        if (res.success) {
            console.log(`✏️ Session renamed to: "${res.session.title}"`);
        } else {
            console.log(`⚠️ ${res.message}`);
        }
        return { handled: true };
    }

    // Notes - /fetch-note-about or /write-about
    if (lower.startsWith("/fetch-note-about ") || lower.startsWith("/write-about ")) {
        const topic = lower.startsWith("/fetch-note-about ") ? input.slice(18).trim() : input.slice(13).trim();
        const { prompt, chunks } = writeAboutPrompt(topic);
        if (!prompt) {
            console.log(`⚠️ No relevant note excerpts found for topic "${topic}".`);
            return { handled: true };
        }
        console.log(`📖 Found ${chunks.length} note excerpt(s). Synthesizing response via Ollama...\n`);
        return { handled: true, compiledPrompt: prompt };
    }

    // PDF Conversion - /convert-pdf or /pdf
    if (lower === "/convert-pdf" || lower.startsWith("/convert-pdf ") || lower === "/pdf" || lower.startsWith("/pdf ")) {
        const parts = input.split(/\s+/);
        const fromDate = parts[1] || "";
        const toDate = parts[2] || "";
        const res = await convertNotesToPdf("notes", "pdfs", fromDate, toDate);
        if (res.success) {
            console.log(`📄 ${res.output}`);
        } else {
            console.log(`⚠️ ${res.error}`);
        }
        return { handled: true };
    }

    // PDF Conversion - /pdf-to-md or /convert-md
    if (lower.startsWith("/pdf-to-md") || lower.startsWith("/convert-md")) {
        const parts = input.split(/\s+/);
        const pdfFile = parts[1] || "";
        if (!pdfFile) {
            console.log("⚠️ Usage: /pdf-to-md <filename.pdf>");
            return { handled: true };
        }
        const res = await convertPdfToMd(pdfFile, "notes");
        if (res.success) {
            console.log(`📄 ${res.output}`);
        } else {
            console.log(`⚠️ ${res.error}`);
        }
        return { handled: true };
    }

    // Local Voice / STT - /voice <audio_file_path>
    if (lower.startsWith("/voice ")) {
        const filePath = input.slice(7).trim();
        if (!filePath) {
            console.log("⚠️ Usage: /voice <path_to_audio_file>");
            return { handled: true };
        }
        try {
            console.log(`🎙 Transcribing voice file '${filePath}' using local Whisper STT...`);
            const sttRes = await transcribeAudioLocal(filePath);
            if (!sttRes.text) {
                console.log("⚠️ Could not transcribe audio file.");
                return { handled: true };
            }
            console.log(`🗣 [Transcribed Speech]: "${sttRes.text}"\n`);
            return { handled: true, compiledPrompt: sttRes.text };
        } catch (err) {
            console.log(`⚠️ Local STT Error: ${err.message}`);
            return { handled: true };
        }
    }

    // Local Voice / TTS - /tts <text>
    if (lower.startsWith("/tts ")) {
        const textToSpeak = input.slice(5).trim();
        if (!textToSpeak) {
            console.log("⚠️ Usage: /tts <text_to_synthesize>");
            return { handled: true };
        }
        try {
            console.log("🔊 Synthesizing speech using local MMS-TTS model...");
            const outPath = path.join(process.cwd(), "pdfs", `speech_${Date.now()}.wav`);
            const ttsRes = await synthesizeSpeechLocal(textToSpeak, outPath);
            console.log(`🔊 Speech audio synthesized locally: ${ttsRes.audioPath}`);
        } catch (err) {
            console.log(`⚠️ Local TTS Error: ${err.message}`);
        }
        return { handled: true };
    }

    // Local Voice Reply / Voice Mode Toggle - /voice-reply [on|off], /voice-mode [on|off]
    if (lower.startsWith("/voice-reply") || lower === "/voicereply" || lower.startsWith("/voice-mode") || lower === "/voicemode") {
        const arg = input.split(/\s+/)[1] || "";
        if (arg.toLowerCase() === "on" || arg.toLowerCase() === "true" || arg.toLowerCase() === "1") {
            context.settings.voice_reply_enabled = true;
        } else if (arg.toLowerCase() === "off" || arg.toLowerCase() === "false" || arg.toLowerCase() === "0") {
            context.settings.voice_reply_enabled = false;
        } else {
            context.settings.voice_reply_enabled = !context.settings.voice_reply_enabled;
        }
        saveSettings(context.settings);
        console.log(`🔊 Automatic Local Voice Reply / Voice Mode is now: ${context.settings.voice_reply_enabled ? "ENABLED (ON)" : "DISABLED (OFF)"}`);
        return { handled: true };
    }

    // Real-Time Voice Socket Server & Web UI - /web, /voice-socket, /voice-server, or /dagowan
    if (lower === "/web" || lower.startsWith("/web ") || lower === "/voice-socket" || lower.startsWith("/voice-socket ") || lower === "/voice-server" || lower.startsWith("/voice-server ") || lower === "/dagowan" || lower.startsWith("/dagowan ")) {
        const parts = input.split(/\s+/);
        const flag = parts[1] ? parts[1].toLowerCase() : null;
        if (flag && ["off", "disable", "disabled", "false", "0"].includes(flag)) {
            if (globalVoiceBridge) {
                globalVoiceBridge.stop();
                globalVoiceBridge = null;
            }
            context.settings.web_enabled = false;
            context.settings.voice_server_enabled = false;
            saveSettings(context.settings);
            console.log("🌐 Dagowan Voice Web Bridge stopped and disabled in app_settings.json.");
        } else {
            context.settings.web_enabled = true;
            context.settings.voice_server_enabled = true;
            saveSettings(context.settings);
            if (!globalVoiceBridge) {
                globalVoiceBridge = new LocalVoiceSocketBridge({ settings: context.settings, characterStore: context.characterStore });
                globalVoiceBridge.start();
            } else {
                console.log("🎙 Real-Time Voice Web Server is already running on http://127.0.0.1:8767");
            }
            console.log("🌐 Voice web server enabled status saved to app_settings.json.");
        }
        return { handled: true };
    }

    return { handled: false };
}
