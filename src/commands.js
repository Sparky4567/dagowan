import {
    remember,
    formatMemories,
    formatMemoryLanguageStats,
    deleteMemory,
    forgetMemory,
    updateMemory,
    getMemoryStore,
    retrieveMemories,
} from "./memory.js";
import { handleNeuromorphicCommand } from "./neuromorphic_command.js";
import {
    KnowledgeStore,
    KnowledgeRetriever,
    formatKnowledge,
    retrieveKnowledge,
} from "./knowledge.js";
import {
    getLearningPipeline,
    getLearningStats,
    getLearningLogs,
} from "./learning.js";
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
import { getActiveCharacter, setActiveCharacter, listCharacters, createCharacter, updateCharacterToken, saveCharacterStore, composeSystemTemplate, findCharacterByName } from "./characters.js";
import {
    listSessions,
    loadSession,
    createSession,
    deleteSession,
    renameSession,
    saveSession,
} from "./sessions.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { writeAboutPrompt } from "./workspace.js";
import { convertNotesToPdf, convertPdfToMd } from "./pdf_utils.js";
import { resetWhatsAppAuth, requestWhatsAppPairing } from "./whatsapp.js";
import { LocalVoiceSocketBridge } from "./voice_socket.js";
import { handleProactiveCommand, ProactiveChatManager } from "./proactive.js";
import { runMakeCommand, runCreateFileCommand, resolveProjectPath } from "./ollama_coding.js";
import { runOpenCliCommand, checkOpenCliAccess } from "./opencli.js";
import { runOpencodeCommand, checkOpencodeAccess, getEffectiveOpencodeModel, requireExplicitProjectPath, runOpencodeSetupStep, formatOpencodeStart, formatOpencodeFinish } from "./opencode.js";
import {
    browserClose,
    browserOpen,
    browserRead,
    browserScreenshot,
    browserSearchSpotify,
    browserSearchYoutube,
    browserStatus,
    formatBlogDraftResult,
    formatSpotifyPlayResult,
    formatPlayResult,
    parseBlogInput,
    parsePlayInput,
    parseSpotifyPlayInput,
} from "./browser.js";
import { playSpotify as playSpotifyViaApi, playYoutube as playYoutubeViaApi, getPlayStatus } from "./play_api.js";
import { detectBlogIntent, draftBlog as draftBlogViaApi, getBlogStatus } from "./blog_api.js";
import { checkFactClaim as checkFactClaimViaApi, formatFactCheckResult, getFactCheckStatus, parseFactCheckInput } from "./factcheck_api.js";
import {
    NEEDLE_DEFAULT_TOOLS,
    executeNeedleCall,
    extractWithNeedle,
    formatNeedleExtractResult,
    formatNeedleRouteResult,
    formatNeedleStatus,
    getNeedleMinConfidence,
    isNeedleAutoRoutingEnabled,
    needleEmbed,
    parseNeedleInput,
    routeWithNeedle,
    runNeedleBridge,
} from "./needle.js";
import { BLOGGER_AUTH_REDIRECT_URI, bloggerAuthRedirectUri, runBloggerAuthFlow } from "./blogger_auth.js";
import { parseCastInput, runCastCommand } from "./cast/caster.js";
import { AgenticModule } from "./agentic.js";
import { saveConfig as saveOllamaCliConfig } from "../ollama_cli/src/config.ts";
import { runBabyAGI, getBabyAGIStatus } from "./babyagi_integration.ts";
import { getSharedModel, setSharedModel } from "./model_selection.js";
import {
    formatMcpStatus,
    formatMcpTools,
    getMcpManager,
    isMcpEnabled,
    loadMcpConfig,
    parseMcpInput,
    saveMcpConfig,
} from "./mcp.js";
import {
    addSimulationMemory,
    buildSimulationSystemPrompt,
    cliScopeKey,
    endSimulation,
    formatSimulationArchiveBlock,
    formatSimulationList,
    formatSimulationMemories,
    formatSimulationReview,
    getActiveSimulation,
    listSimulations,
    loadSimulation,
    parseSimulationCommand,
    searchSimulation,
    searchSimulationArchives,
    startSimulation,
} from "./simulation.js";
import {
    CLI_SCOPE,
    OTP_KEYS,
    isOtpAuthenticated,
    isOtpCommand,
    isOtpSet,
    isProbablyControlCommand,
    isSecurityPinSet,
    isScopeUnlocked,
    isSurfaceLocked,
    lockedMessage,
    otpLoginHelpLine,
    runOtpCommand,
    runSecurityCommand,
    SECURITY_PIN_KEYS,
    unlockHelpLine,
} from "./security.js";

let globalVoiceBridge = null;
let globalDashboardServer = null;

// Dynamic command manual: the unlock/OTP duration lines are generated from
// the live `security_unlock_minutes` value (app_settings.json) instead of a
// hard-coded "default 10" / "N minutes" string. Callers on every surface
// (CLI / Telegram / WhatsApp / Web) must use buildCommandsHelp(settings).
const COMMANDS_HELP_TEMPLATE = `🤖 Available Commands in Ollama Chat (Bun / m-edit toolsuite):

🎙 Local Voice & Audio Commands (100% Offline Local Models):
• @voice <audio_file_path> — Transcribe voice attachment locally (Whisper STT) & generate answer
• @tts <text> — Synthesize text locally into speech audio (MMS-TTS)
• @voice-reply [on|off] (or @voicereply) — Toggle automatic local voice note response generation (saved to app_settings.json)
• @web [on|off] (or @voice-socket, @voice-server, @dagowan) — Launch/toggle real-time duplex voice web interface (http://127.0.0.1:8767)
• @dashboard [on|off] [port] (or @dash) — Launch/toggle OpenWebUI-style chat dashboard (http://127.0.0.1:8768; custom port via @dashboard 8899, DASHBOARD_PORT, or --dashboard-port N)
• @web-search <query> [--provider auto|duckduckgo|brave|tavily|google-ai] [--limit N] (or @websearch) — Live web search injected into the next LLM answer (works for ALL cloud models: OpenAI/Gemini/Claude/Grok/Mistral + local Ollama). Inline forms: @live-web ("latest BTC price @live-web") or @live-gemini ("explain black holes @live-gemini")
• @web-fetch <url> (or @webfetch) — Fetch a page as plain text (read a search result in full)
• @web-status — Show web search engine configuration

📄 PDF Conversion Commands:
• @convert-pdf [from_date] [to_date] (or @pdf 2026-07 2026-08) — Batch convert Markdown notes in date range to PDF files in pdfs/
• @pdf-to-md [filename.pdf] (or @convert-md notes.pdf) — Convert a PDF file back into Markdown notes in notes/

📋 Kanban & Task Management Commands:
• @register-task <description> (or @task <desc>) — Register a new task in Processing status
• @get-tasks (or @tasks) — List all active (unfinished) tasks
• @all-tasks — List all Kanban tasks (including finished)
• @move-task-<id>-(p|o|f) (or @move-task <id> <p|o|f>) — Move task status (p: processing, o: ongoing, f: finished)
• @delete-task-<id> (or @delete-task <id>) — Delete task by ID
• @set-task-reminder <minutes> — Enable automatic task reminders (saved to app_settings.json)
• @stop-task-reminder — Disable task reminders (saved to app_settings.json)
• @task-reminder-status — Show current task reminder settings

⏱ Proactive Chat & Timer Commands:
• @set-proactive-timer <minutes> (or @proactive-timer <mins>) — Set proactive chat idle timer in minutes (saved to app_settings.json)
• @proactive-chat [on|off] (or @proactive [on|off]) — Enable, disable, or toggle proactive chat check-ins
• @proactive-status (or @proactive-timer-status) — View current proactive chat timer & check-in settings
• @stop-proactive-timer (or @stop-proactive) — Disable proactive chat check-ins
• @set-proactive-check <seconds> (or @proactive-check <secs>) — Set background check frequency in seconds (default 60s)

🧠 Incremental Memory & Knowledge Commands (Eliza Cognitive Layer):
• @remember <text> — Save a persistent memory for the ACTIVE character only (language auto-detected; stored in memory.json + memory.<lang>.json)
• @memories [query] (or @memory, @list-memories) — List recent active persistent memories (15) for the ACTIVE character (shows [owner] [lang] per entry) or search with query (query language auto-detected: same-language pool + shared first, other languages via bridge)
• @memories-all [query] (or @memory-all, @list-memories-all) — List ALL active persistent memories for the ACTIVE character, or search across all with query
• @memory-langs — Show per-language memory counts (lt / en / es / it / … pools)
• @forget <id|index> (or @delete-memory) — Deactivate/forget a specific memory by ID or index
• @update-memory <id|index> <text> — Update memory content by index or ID
• @neuromorphic-memory / @nc-mem [status|toggle|consolidate|prune|spikes|help] — Neuromorphic Cognitive Memory: plasticity (activation/decay/Hebbian) re-ranking of memory retrieval
• @correct <statement> — Submit explicit user correction (superseding conflicting prior beliefs)
• @knowledge [query] (or @list-knowledge) — List or search knowledge base concepts & entries
• @teach <title: content> — Explicitly teach the bot a structured concept or definition
• @knowledge-history <id> — View version history of a knowledge concept
• @delete-knowledge <id> — Deprecate/remove a knowledge entry
• @stats (or @learning-stats) — Display database, memory, knowledge, and learning statistics
• @learning-logs [limit] — View recent incremental learning events log
• @set-learning [on|off] (or @auto-learning) — Toggle automatic background LLM learning extraction
• @rules [status] — Inspect candidate and approved pattern rules
• @approve-rule <id> — Approve a candidate rule
• @insight [optional focus] — Write today's daily self-reflection with the active LLM (one per character per day) into data/reflections.json; recalled automatically as [Relevant Self-Reflections] in later chats
• @insights [N] (or @insight-list) — List recent self-reflections for the ACTIVE character
• @insight-search <query> — Search the reflection bank by association
• @insight-show <id|YYYY-MM-DD> — Show one reflection entry
• @insight-delete <id|YYYY-MM-DD> — Delete one reflection entry
• @insight-auto [on|off|status|every <n>|cooldown <mins>] — Adaptive background self-memory: micro-insight every N substantive turns (default 8, ≥24 chars, skips trivial/commands) + cooldown; stored as source:auto-insight and recalled like daily reflections

🎭 Character Profiles & Persona Commands:
• @model [model-name] — View or switch active LLM model (supports Ollama, Gemini, Claude, Grok, Mistral, ChatGPT)
• @models — List available models across all providers (Ollama, Gemini, Claude, Grok, Mistral, OpenAI)
• @set-api-key <provider> <key> (or @set-key <provider> <key>) — Save API key for openai, gemini, claude, grok, mistral, youtube, spotify, wordpress, blogger, brave, tavily to app_settings.json (spotify takes "<client_id> <client_secret>"; wordpress takes "<site_url> <username> <app_password>"; blogger takes "<blog_id> <access_token>")
• @api-keys (or @keys) — List status of configured provider API keys
🎭 Simulation Mode (simple separate chat inside the active persona):
• @simulation <name> [optional note] — Start/resume a simulation; just normal chat with the same persona (each sim has its own archive file in data/simulations/)
• @simulation-end (or @simulation-stop, @simulation-passed, @simulation-pass, @simulation end/stop/passed) — Archive & end the active simulation
• @simulation (bare) — Show active simulation status
• @simulations (or @simulation-list) — List simulation archives
• @simulation-search <query> — Search across simulation archives by association
• @simulation-show <name> — Show a simulation archive summary
• @simulation-review <name> (or @simulation review <name>) — Full review of ALL conversational data in a saved simulation (stats + topics + every turn)
• While active, chats + @remember memories stay inside the simulation file; past archives are recalled automatically when the prompt matches.
• @character [name|id] — View or switch active character persona (wakes its Telegram polling on demand)
• @characters — List available character personas (and saved Telegram tokens)
• @polling-status — Show per-persona Telegram polling state (active always polls; idle personas auto-sleep)
• @wake <name|id> — Start polling for a persona on demand
• @sleep <name|id> — Stop polling for an idle persona (active persona cannot sleep)
• @set-polling-idle <minutes> — Set idle auto-sleep timeout for non-active personas (0 disables)
• @create-character <name> | <prompt> — Create a custom character persona using the shared model
• @set-telegram-token <token> [character_id] — Save Telegram token to characters.json / app_settings.json
• @set-persona-prompt <prompt> [character_id] — Save persona system prompt template to characters.json
• @whatsapp-pair <phone_number> — Generate 8-digit WhatsApp pairing code for "Link with phone number instead"
• @set-whatsapp-phone <phone_number> (or @whatsapp-number) — Save WhatsApp phone number setting in app_settings.json
• @whatsapp-enabled [on|off] (or @set-whatsapp) — Toggle WhatsApp bridge enabled setting in app_settings.json
• @reset-whatsapp-auth — Reset desynced WhatsApp auth keys & generate new QR / pairing code

💬 Chat Session Commands:
• @sessions — List saved conversation sessions
• @session <id> — Switch to session by ID
• @new-session — Start a fresh conversation session
• @delete-session <id> — Delete session by ID
• @rename-session <title> — Rename active session

💾 Backup & Settings Commands:
• @settings (or @get-settings) — View all current application settings from app_settings.json
• @set-setting <key> <value> — Update and save any setting to app_settings.json
• @set-server-url <url> — Set Ollama server URL and save to app_settings.json
• @ephemeral [on|off|status] (or @one-shot) — Toggle one-shot Ollama inference via bun-ollama CLI (default ON: model loads per turn, answers once, then unloads to free RAM; OFF = persistent server, model stays resident). Keys: ollama_ephemeral, ollama_lite_dir, ollama_ephemeral_timeout_ms
• @set-mem-limit <num> — Set memory context message limit and save to app_settings.json
• @set-workspace <name> — Set active workspace name and save to app_settings.json
• @export-settings [name] (or @backup) — Export settings, prompts, memories, and tasks to backups/
• @import-settings [filename] (or @restore) — Restore app state from backups/
• @list-backups — List available backup files

🔒 Security PIN Commands (when a PIN is set, all @ control commands need @unlock first; regular chatting always works):
• @set-security-pin <6+ digits> [current-pin] (or @set-pin) — Set or change the PIN (digits only, min 6). First-time setup needs no PIN; changing it needs @unlock or the current PIN
{{UNLOCK_HELP_LINE}}
• @lock — Lock immediately (PIN layer; OTP auth is dropped separately with @otp-lock)
• @security-status (or @security, @pin-status) — Show whether a PIN is set and whether this surface is unlocked
• @remove-security-pin [pin] (or @clear-security-pin) — Remove PIN protection (needs unlock or current PIN)

🔐 OTP 2FA Commands (Google Authenticator / any TOTP app; OTP layer sits BEFORE @unlock — while enrolled, every @ control command needs @otp-login first):
• @otp-set [account] — Enroll a new authenticator secret (needs @unlock first when a PIN is set; rotating an existing secret needs @otp-login + @unlock). Prints the secret + otpauth:// URL to add in your app
{{OTP_LOGIN_HELP_LINE}}
• @otp-lock — Drop OTP authentication on this surface (control commands lock again)
• @otp-status (or @otp) — Show whether OTP is enrolled and whether this surface is authenticated
• @otp-remove <code> — Remove OTP protection (needs BOTH @otp-login auth and @unlock when a PIN is set; the code may be passed inline)

🛠 Ollama CLI Coding Commands:
• @change-project-path <path> (or @project-path) — Set and persist project/code output directory for @make and @create-file (saved to app_settings.json)
• @make <project_description> — Execute Ollama CLI agentic toolset (read/write files, list dir, run shell commands, grep search) to build complete projects in project path
• @create-file <file_path> [content|prompt] — Create or generate a file using Ollama CLI toolset in project path (auto-creates missing directories)
• @opencli <task_description> — API-driven OpenAI coding agent (read/write/run tools, jailed to project path, owner-gated on Telegram/WhatsApp; needs OPENAI_API_KEY)
• @opencode <task_description> — Run the external opencode CLI in the project path (owner-gated on Telegram/WhatsApp; needs @set-project-path <dir> first; model via @opencode-model or opencode's own config)
• @opencode-model [<model>] — Show or set the model for @opencode (@set-setting opencode_model <provider/model>; empty = use opencode's own configured model)
• @opencode-setup [status|path <dir>|model <m>|models|auth|bin <path>|auto on|off|auto-allow [full|safe|review|status|clear]|test [task]] — Guided opencode setup: binary/auth/path/model checks with fix commands, plus an end-to-end test
• @opencode-setup-auto-allow [full|safe|review|status|clear] — Write auto-allow file permissions into <projectDir>/opencode.json (full = hands-free file creation/editing + bash; safe = file ops allow, bash asks; review = read-only). Alias for @opencode-setup auto-allow

🍼 BabyAGI Autonomous Planning:
• @babyagi <objective> [--iterations N] — Run the classic BabyAGI task execution → creation → prioritization loop (1–20 iterations; default 3)
• @babyagi-status — Show the BabyAGI function registry, execution log, and vector-memory counts

🔌 MCP (Model Context Protocol) Servers:
• @mcp-status — Show MCP enabled state, configured servers, and connection state
• @mcp-list — List configured MCP servers from mcp_servers.json
• @mcp-tools [server] — List tools from connected MCP servers (agents use server__tool names)
• @mcp-call <server__tool> [json_args] — Call one MCP tool directly
• @mcp-reconnect [server] — Drop cached connections (lazy re-spawn on next use)
• @mcp-enable <server> / @mcp-disable <server> — Toggle a server in mcp_servers.json

🔍 Search & Browser Commands:
• @fetch-note-about <topic> (or @write-about <topic>) — Search notes for topic and compile prompt
• @search-youtube-for <query> — Search YouTube in default host browser (legacy fire-and-forget open)
• @search-spotify-for <query> — Search Spotify in default host browser (legacy fire-and-forget open)
• @youtube-play <query|YouTube URL> [--no-show] (or @play) — API-first (YOUTUBE_API_KEY) YouTube playback with host-browser handoff; Chromium automation is the fallback (PLAY_SOURCE=auto|api|browser, @set-setting play_source <mode>)
• @spotify-play <query|Spotify URL> [--no-show] (or @spotify) — API-first (SPOTIFY_CLIENT_ID/SECRET) Spotify playback with host-browser handoff; Chromium automation is the fallback
• @blog <topic> [--on wordpress|blogger] [--title <title>] [--no-show] (or @wordpress, @blogger, @post) — API-first (WordPress REST / Blogger API v3) blog draft with host-browser handoff; Chromium editor automation is the fallback (BLOG_SOURCE=auto|api|browser, @set-setting blog_source <mode>)
• @blogger-auth [client_secret_file] (CLI only) — Google OAuth loopback flow for the Blogger API: opens the consent screen, stores access + refresh tokens (auto-refreshed); needs http://127.0.0.1:8791/callback registered as an Authorized redirect URI first
• @fact-check <claim> [--limit N] [--source auto|papers|gemini] [--model <gemini-model>] [--no-verdict] (or @factcheck, @verify) — Search Semantic Scholar for papers (title, abstract, citations, DOI/PDF) to verify a claim; anonymous access works, SEMANTIC_SCHOLAR_API_KEY raises rate limits; with GEMINI_API_KEY set a Gemini verdict is added on top (FACTCHECK_SOURCE=auto|papers|gemini)
• @needle <request> — On-device routing via cactus-needle (8-29 MB local model): picks a local tool (remember / task / note / timer) with grammar-guaranteed args and a calibrated confidence score; empty call list means refusal. With @set-setting needle_enabled 1, confident local-action turns on any surface skip the main LLM automatically
• @needle-extract <JSON schema> <text> — Typed field extraction without a large LLM (e.g. @needle-extract {"type":"object","properties":{"total":{"type":"number"}}} Invoice total $12)
• @needle-embed <text> — Local embedding vector for search/match/route debugging
• @needle-tools — List the on-device tool catalog
• @needle-status — Show Needle install / model / threshold status
• @browser-search <query> — YouTube search in the local browser window, top results without playing
• @browser-search-spotify <query> — Spotify search in the local browser window, top results without playing
• @browser-open <url> — Navigate the local browser window (allowlisted domains only)
• @browser-read — Read text of the current page
• @browser-shot [name] — Screenshot the current page into tmp/
• @browser-status — Show browser state
• @browser-close — Close the local browser
• @search-google-for <query> — Search Google in default browser
• @search-giphy-for <query> — Search Giphy in default browser
• @open-browser — Open default web browser

📺 TV Cast Commands (Castor-style, Bun-only, needs ffmpeg + Chromium):
• @cast-scan (or @scan-tv) — List TVs/renderers on your LAN (DLNA + Chromecast)
• @cast <url> — Auto: direct video URL casts as-is, page URL is extracted first
• @cast <youtube-url> — Plays in the TV's native YouTube app (needs Chromecast/Android TV target)
• @cast-url <url> — Cast a direct stream/video URL (.mp4, .mkv, .m3u8, …)
• @cast-player <page-url> — Extract the video from a web page, then cast
• @cast-pause / @cast-play — Pause / resume playback on the TV
• @cast-status — Show current cast session + TV transport state
• @cast-stop (or @stop-cast) — Stop playback and shut down the relay
• @set-cast-device <name|ip|description-url> — Select/pin the target TV (IP uses unicast, works where multicast is blocked)

ℹ️ General Commands:
• @clear — Clear active conversation context
• @get-commands (or @commands, @help) — Display this list of commands
• exit / quit — Save session and quit
`;

// Build the @help manual with the live unlock duration from settings.
// Falls back to defaults when settings are missing so old callers that
// import COMMANDS_HELP keep working.
export function buildCommandsHelp(settings) {
    return COMMANDS_HELP_TEMPLATE
        .replaceAll("{{UNLOCK_HELP_LINE}}", unlockHelpLine(settings))
        .replaceAll("{{OTP_LOGIN_HELP_LINE}}", otpLoginHelpLine(settings));
}

// Static snapshot with default settings (backward compatibility for
// existing imports). Prefer buildCommandsHelp(liveSettings) everywhere.
export const COMMANDS_HELP = buildCommandsHelp();

export async function handleAtCommand({
    commandStr,
    context,
    ollamaClient,
}) {
    const rawInput = String(commandStr || "").trim();
    // Canonical prefix is "@" (MCP-style). A leading "/" is still accepted
    // for backward compatibility and normalized here so all parsing below
    // can stay in "/" form (same length, same slice offsets).
    const input = rawInput.startsWith("@") ? "/" + rawInput.slice(1) : rawInput;
    const lower = input.toLowerCase();

    // ---- Security PIN + OTP (work while locked; everything else below is gated) ----
    {
        const settings = (context && context.settings) || {};
        const secRes = runSecurityCommand(rawInput, settings, CLI_SCOPE);
        if (secRes.handled) {
            if (secRes.settingsChanged) saveSettings(settings);
            console.log(`\n${secRes.reply}\n`);
            return { handled: true };
        }
        const otpRes = runOtpCommand(rawInput, settings, CLI_SCOPE);
        if (otpRes.handled) {
            if (otpRes.settingsChanged) saveSettings(settings);
            console.log(`\n${otpRes.reply}\n`);
            return { handled: true };
        }
        if (isSurfaceLocked(settings, CLI_SCOPE)) {
            const chars = (context && context.characterStore && context.characterStore.characters) || [];
            if (isProbablyControlCommand(rawInput, chars) || detectBlogIntent(rawInput)) {
                console.log(`\n${lockedMessage(settings, CLI_SCOPE)}\n`);
                return { handled: true };
            }
            return { handled: false };
        }
    }

    // Help — gated like any other control command: while OTP/PIN locked,
    // the block above already refused it with lockedMessage, so reaching
    // here means this surface is authenticated (or nothing is enrolled).
    if (lower === "/help" || lower === "/commands" || lower === "/get-commands") {
        console.log(`\n${buildCommandsHelp(context && context.settings)}`);
        return { handled: true };
    }

    // ---- Simulation mode (simple separate chat inside active persona) ----
    // Must run before @remember/@memories so those can be sim-aware below,
    // and before any other command that would treat "@simulation ..." as chat.
    {
        const simParsed = parseSimulationCommand(rawInput);
        if (simParsed) {
            let activeCharId = null;
            let activeCharName = "";
            try {
                const ac = getActiveCharacter(context.characterStore);
                activeCharId = ac.id;
                activeCharName = ac.name;
            } catch { activeCharId = context?.settings?.active_character || null; }
            const scope = cliScopeKey(activeCharId || "main");
            if (simParsed.action === "start") {
                try {
                    const existing = getActiveSimulation(scope);
                    if (existing && existing.slug !== simParsed.name.toLowerCase().replace(/[^a-z0-9-_]+/g, "-")) {
                        console.log(`⚠️ Simulation "${existing.name}" is already active. End it first with @simulation-end, then start "${simParsed.name}".`);
                        return { handled: true };
                    }
                    const sim = startSimulation({
                        name: simParsed.name,
                        scenario: simParsed.scenario || "",
                        characterId: activeCharId,
                        personaName: activeCharName,
                        scopeKey: scope,
                    });
                    if (context && Array.isArray(context.messages)) {
                        context.messages.push({ role: "system", content: `[Simulation Started]: "${sim.name}"${sim.scenario ? ` — ${sim.scenario}` : ""}` });
                        if (context.activeSessionId) saveSession(context.activeSessionId, context.messages, activeCharId);
                    }
                    console.log(`🎭 Simulation "${sim.name}" started inside persona "${activeCharName || activeCharId}".\n${buildSimulationSystemPrompt(activeCharName, sim)}\n💾 Archive: data/simulations/${sim.slug}.json — chats + memories stay inside this file until @simulation-end.`);
                } catch (err) {
                    console.log(`⚠️ Simulation start error: ${err.message || err}`);
                }
                return { handled: true };
            }
            if (simParsed.action === "end") {
                const sim = endSimulation(scope);
                if (!sim) {
                    console.log("⚠️ No active simulation to end for this persona.");
                    return { handled: true };
                }
                const exchanges = Math.floor((sim.messages || []).length / 2);
                if (context && Array.isArray(context.messages)) {
                    context.messages.push({ role: "system", content: `[Simulation Ended]: "${sim.name}" — ${exchanges} exchange(s), ${(sim.memories || []).length} memori(es) archived to data/simulations/${sim.slug}.json` });
                    if (context.activeSessionId) saveSession(context.activeSessionId, context.messages, activeCharId);
                }
                console.log(`🎭 Simulation "${sim.name}" ended & archived (${exchanges} exchange(s), ${(sim.memories || []).length} memori(es)). Past archives are still recalled by association via @simulation-search or automatically in chat.`);
                return { handled: true };
            }
            if (simParsed.action === "status") {
                const sim = getActiveSimulation(scope);
                if (!sim) {
                    const all = listSimulations({});
                    console.log(`🎭 No active simulation for "${activeCharName || activeCharId}".\n${formatSimulationList(all)}\n💡 Start with @simulation <name>.`);
                } else {
                    console.log(`🎭 ACTIVE simulation "${sim.name}" [${sim.slug}] inside "${activeCharName || activeCharId}" — ${Math.floor((sim.messages || []).length / 2)} exchange(s), ${(sim.memories || []).length} memori(es).${sim.scenario ? `\nNote: ${sim.scenario}` : ""}\nEnd with @simulation-end (or @simulation-stop / @simulation-passed).`);
                }
                return { handled: true };
            }
            if (simParsed.action === "list") {
                const active = getActiveSimulation(scope);
                console.log(`\n${formatSimulationList(listSimulations({}), active?.slug)}\n`);
                return { handled: true };
            }
            if (simParsed.action === "search") {
                const q = (simParsed.query || "").trim();
                if (!q) {
                    console.log("⚠️ Usage: @simulation-search <query>");
                    return { handled: true };
                }
                const hits = searchSimulationArchives(q, { limit: 8 });
                if (hits.length === 0) {
                    console.log(`🎭 No simulation archive matches for "${q}".`);
                } else {
                    console.log(`\n${formatSimulationArchiveBlock(hits)}\n`);
                }
                return { handled: true };
            }
            if (simParsed.action === "show") {
                const sim = simParsed.name ? loadSimulation(simParsed.name) : getActiveSimulation(scope);
                if (!sim) {
                    console.log(`⚠️ Simulation "${simParsed.name || ""}" not found.`);
                    return { handled: true };
                }
                console.log(`\n🎭 Simulation "${sim.name}" [${sim.slug}] (${sim.status}) — persona "${sim.personaName || sim.characterId || "?"}":${sim.scenario ? `\nNote: ${sim.scenario}` : ""}\nExchanges: ${Math.floor((sim.messages || []).length / 2)} | Memories: ${(sim.memories || []).length}\n`);
                const mems = (sim.memories || []).slice(-10);
                for (const m of mems) console.log(`  • [${m.type}] ${m.content}`);
                console.log("");
                return { handled: true };
            }
            if (simParsed.action === "review") {
                const target = (simParsed.name || "").trim();
                const sim = target ? loadSimulation(target) : getActiveSimulation(scope);
                if (!sim) {
                    console.log(`⚠️ Simulation "${target}" not found.${target ? "" : " Pass a name: @simulation-review <name>."}`);
                    return { handled: true };
                }
                console.log(`\n${formatSimulationReview(sim.slug)}\n`);
                return { handled: true };
            }
            if (simParsed.action === "delete") {
                if (!simParsed.name) {
                    console.log("⚠️ Usage: @simulation delete <name>");
                    return { handled: true };
                }
                const { deleteSimulation } = await import("./simulation.js");
                const ok = deleteSimulation(simParsed.name);
                console.log(ok ? `🗑 Simulation "${simParsed.name}" archive deleted.` : `⚠️ Simulation "${simParsed.name}" not found.`);
                return { handled: true };
            }
        }
    }

    // ---- Daily self-reflections (@insight family; lock-gated like any control command) ----
    {
        const { handleAutoInsightCommand, parseAutoInsightCommand } = await import("./auto_insight.js");
        if (parseAutoInsightCommand(rawInput)) {
            const res = await handleAutoInsightCommand(rawInput, {
                settings: (context && context.settings) || {},
                persist: (s) => saveSettings(s),
            });
            if (res.handled) {
                console.log(`\n${res.reply}\n`);
                return { handled: true };
            }
        }
        const { parseInsightCommand, handleReflectionBridgeCommand } = await import("./reflections.js");
        if (parseInsightCommand(rawInput)) {
            let activeCharId = null;
            let activeCharName = "";
            try {
                const ac = getActiveCharacter(context.characterStore);
                activeCharId = ac.id;
                activeCharName = ac.name;
            } catch { activeCharId = context?.settings?.active_character || null; }
            const res = await handleReflectionBridgeCommand(rawInput, {
                characterId: activeCharId,
                personaName: activeCharName,
                settings: (context && context.settings) || {},
                ollamaClient: ollamaClient || null,
            });
            if (res.handled) {
                console.log(`\n${res.reply}\n`);
                return { handled: true };
            }
        }
    }

    // BabyAGI classic autonomous loop. It shares the selected assistant provider,
    // so it works with Ollama, OpenAI, Gemini, Claude, Grok, or Mistral configuration.
    if (lower === "/babyagi-status") {
        try {
            const status = await getBabyAGIStatus(context?.settings || {});
            console.log(`🍼 BabyAGI ready — functions: ${status.functions.join(", ") || "none"}; logs: ${status.executionLogs}; memory items: ${status.memoryItems}.`);
        } catch (err) {
            console.log(`⚠️ BabyAGI status error: ${err.message || err}`);
        }
        return { handled: true };
    }

    if (lower.startsWith("/babyagi") || lower === "/babyagi") {
        const payload = input.slice("/babyagi".length).trim();
        if (!payload) {
            console.log("⚠️ Usage: @babyagi <objective> [--iterations N]");
            console.log("Example: @babyagi Create a launch plan for a local voice assistant --iterations 4");
            return { handled: true };
        }

        const iterationsMatch = payload.match(/\s+--iterations\s+(\d+)\s*$/i);
        const objective = (iterationsMatch ? payload.slice(0, iterationsMatch.index) : payload).trim();
        const iterations = iterationsMatch ? Number(iterationsMatch[1]) : 3;
        if (!objective) {
            console.log("⚠️ A BabyAGI objective is required.");
            return { handled: true };
        }

        try {
            const result = await runBabyAGI(objective, context?.settings || {}, iterations);
            const summary = `🍼 BabyAGI completed ${result.completedIterations} iteration(s) for “${objective}”. Remaining tasks: ${result.remainingTasks.length}.`;
            console.log(summary);
            if (context && Array.isArray(context.messages)) {
                context.messages.push({ role: "user", content: input });
                context.messages.push({ role: "assistant", content: summary });
                if (context.activeSessionId) saveSession(context.activeSessionId, context.messages);
            }
        } catch (err) {
            console.log(`⚠️ BabyAGI error: ${err.message || err}`);
        }
        return { handled: true };
    }

    // Ollama CLI Coding Agent - @make <prompt>
    if (lower.startsWith("/make") || lower === "/make") {
        const promptText = input.slice(5).trim();
        if (!promptText) {
            console.log("⚠️ Usage: @make <project or coding task description>");
            console.log("Example: @make Create a python script in server.py that fetches weather data");
            return { handled: true };
        }

        try {
            const res = await runMakeCommand(promptText, context ? context.settings : {});
            if (context && Array.isArray(context.messages)) {
                context.messages.push({
                    role: "user",
                    content: input,
                });
                context.messages.push({
                    role: "assistant",
                    content: res.output || `🔨 [Ollama CLI]: Completed coding task "${promptText}"`,
                });
                if (context.activeSessionId) {
                    saveSession(context.activeSessionId, context.messages);
                }
            }
        } catch (err) {
            console.log(`⚠️ Ollama CLI @make error: ${err.message || err}`);
        }
        return { handled: true };
    }

    // Ollama CLI File Generator - @create-file <path> [content|prompt]
    if (lower.startsWith("/create-file") || lower === "/create-file") {
        const payload = input.slice(12).trim();
        if (!payload) {
            console.log("⚠️ Usage: @create-file <file_path> [content or description]");
            console.log("Example: @create-file ./src/app.js console.log('Hello World');");
            console.log("Example: @create-file ./server.js A simple Bun HTTP server");
            return { handled: true };
        }

        const firstSpaceIdx = payload.search(/\s/);
        let filePath = payload;
        let contentOrPrompt = "";
        if (firstSpaceIdx !== -1) {
            filePath = payload.slice(0, firstSpaceIdx).trim();
            contentOrPrompt = payload.slice(firstSpaceIdx + 1).trim();
        }

        try {
            const res = await runCreateFileCommand(filePath, contentOrPrompt, context ? context.settings : {});
            if (res.success) {
                console.log(`📄 ${res.output}`);
                if (context && Array.isArray(context.messages)) {
                    context.messages.push({
                        role: "user",
                        content: input,
                    });
                    context.messages.push({
                        role: "assistant",
                        content: `📄 [Ollama CLI File]: ${res.output}`,
                    });
                    if (context.activeSessionId) {
                        saveSession(context.activeSessionId, context.messages);
                    }
                }
            } else {
                console.log(`⚠️ ${res.error}`);
            }
        } catch (err) {
            console.log(`⚠️ Ollama CLI @create-file error: ${err.message || err}`);
        }
        return { handled: true };
    }

    // OpenCLI - @opencli <task> (local surface: always allowed when enabled)
    if (lower === "/opencli" || lower.startsWith("/opencli ")) {
        const taskText = input.slice(8).trim();
        if (!taskText) {
            console.log("⚠️ Usage: @opencli <project or coding task description>");
            console.log("Example: @opencli Scaffold a bun + sqlite todo API in ./todo-api with tests");
            return { handled: true };
        }

        try {
            const res = await runOpenCliCommand(taskText, context ? context.settings : {});
            if (!res.success) {
                console.log(res.error);
            } else if (context && Array.isArray(context.messages)) {
                console.log(`🤖 ${res.output}`);
                context.messages.push({
                    role: "user",
                    content: input,
                });
                context.messages.push({
                    role: "assistant",
                    content: `🤖 [OpenCLI]: ${res.output}`,
                });
                if (context.activeSessionId) {
                    saveSession(context.activeSessionId, context.messages);
                }
            } else {
                console.log(`🤖 ${res.output}`);
            }
        } catch (err) {
            console.log(`⚠️ @opencli error: ${err.message || err}`);
        }
        return { handled: true };
    }

    // opencode CLI auto-allow alias - @opencode-setup-auto-allow [mode] (before @opencode-setup)
    if (lower === "/opencode-setup-auto-allow" || lower.startsWith("/opencode-setup-auto-allow ")) {
        const modeArgs = input.slice(26).trim();
        try {
            const res = await runOpencodeSetupStep(`auto-allow ${modeArgs}`.trim(), context ? context.settings : {});
            if (res.settingsChanged && context && context.settings) {
                saveSettings(context.settings);
            }
            console.log(res.reply);
            return { handled: true };
        } catch (err) {
            console.log(`⚠️ @opencode-setup-auto-allow error: ${err.message || err}`);
            return { handled: true };
        }
    }

    // opencode CLI guided setup - @opencode-setup [...] (before @opencode-model: prefix overlap)
    if (lower === "/opencode-setup" || lower.startsWith("/opencode-setup ")) {
        const stepArgs = input.slice(15).trim();
        try {
            const res = await runOpencodeSetupStep(stepArgs, context ? context.settings : {});
            if (res.settingsChanged && context && context.settings) {
                saveSettings(context.settings);
                if (stepArgs.toLowerCase().startsWith("path")) {
                    try {
                        await saveOllamaCliConfig({ projectPath: context.settings.project_path });
                    } catch {}
                }
            }
            console.log(res.reply);
            return { handled: true };
        } catch (err) {
            console.log(`⚠️ @opencode-setup error: ${err.message || err}`);
            return { handled: true };
        }
    }

    // opencode CLI model - @opencode-model [<model>] (before @opencode: prefix overlap)
    if (lower === "/opencode-model" || lower.startsWith("/opencode-model ")) {
        const arg = input.slice(15).trim();
        const settings = context ? context.settings : {};
        if (!arg) {
            let projectPath = null;
            try {
                projectPath = requireExplicitProjectPath(settings);
            } catch {}
            const eff = getEffectiveOpencodeModel(settings || {}, projectPath);
            const where = eff.source === "setting"
                ? "user setting (opencode_model)"
                : eff.source === "project"
                    ? `project opencode.json (${projectPath})`
                    : eff.source === "global"
                        ? "global opencode config (~/.config/opencode/opencode.json)"
                        : "none configured";
            console.log(`🤖 @opencode model: ${eff.model || "(opencode default)"} [${where}]`);
            console.log("💡 Set it: @opencode-model <provider/model> (e.g. @opencode-model ollama/qwen3:8b) or clear with @set-setting opencode_model \"\"");
            return { handled: true };
        }
        try {
            if (context && context.settings) {
                context.settings.opencode_model = arg;
                saveSettings(context.settings);
            }
            console.log(`🤖 @opencode model set to "${arg}" (saved to app_settings.json).`);
            return { handled: true, success: true };
        } catch (err) {
            console.log(`⚠️ Failed to set @opencode model: ${err.message || err}`);
            return { handled: true, success: false };
        }
    }

    // opencode CLI - @opencode <task> (local surface: always allowed when enabled)
    if (lower === "/opencode" || lower.startsWith("/opencode ")) {
        const taskText = input.slice(9).trim();
        if (!taskText) {
            console.log("⚠️ Usage: @opencode <project or coding task description>");
            console.log("Example: @opencode Fix the failing login test in ./web-app");
            console.log("Needs @set-project-path <dir> first; model via @opencode-model or opencode's own config.");
            return { handled: true };
        }

        try {
            const startedAt = Date.now();
            console.log(formatOpencodeStart(taskText, (() => {
                try {
                    const pp = requireExplicitProjectPath(context ? context.settings : {});
                    const eff = getEffectiveOpencodeModel(context ? context.settings : {}, pp);
                    return { projectPath: pp, model: eff.model || "(opencode default)", modelSource: eff.source };
                } catch { return {}; }
            })()));
            const res = await runOpencodeCommand(taskText, context ? context.settings : {});
            const elapsedMs = res.elapsedMs ?? (Date.now() - startedAt);
            if (!res.success) {
                console.log(formatOpencodeFinish(taskText, res, elapsedMs));
            } else if (context && Array.isArray(context.messages)) {
                const done = formatOpencodeFinish(taskText, res, elapsedMs);
                console.log(done);
                context.messages.push({
                    role: "user",
                    content: input,
                });
                context.messages.push({
                    role: "assistant",
                    content: done,
                });
                if (context.activeSessionId) {
                    saveSession(context.activeSessionId, context.messages);
                }
            } else {
                console.log(formatOpencodeFinish(taskText, res, elapsedMs));
            }
        } catch (err) {
            console.log(`⚠️ @opencode error: ${err.message || err}`);
        }
        return { handled: true };
    }

    // Ollama CLI Project Path - @change-project-path [path], @project-path [path], @set-project-path <path>
    if (
        lower.startsWith("/change-project-path") ||
        lower.startsWith("/set-project-path") ||
        lower.startsWith("/project-path") ||
        lower.startsWith("/projects-path") ||
        lower.startsWith("/set-projects-path")
    ) {
        const rawArgs = input.replace(/^\/(change-project-path|set-project-path|project-path|projects-path|set-projects-path)/i, "").trim();
        const currentPath = resolveProjectPath(context ? context.settings : {});

        if (!rawArgs) {
            console.log(`📁 Current Project Path: "${currentPath}" (setting: "${context?.settings?.project_path || "projects"}")`);
            console.log("💡 To change project path: @change-project-path <new_folder_path>");
            return { handled: true, projectPath: currentPath };
        }

        let newPath = rawArgs;
        if (newPath.startsWith("~")) {
            newPath = path.join(os.homedir(), newPath.slice(1));
        }
        const absNewPath = path.isAbsolute(newPath) ? newPath : path.resolve(process.cwd(), newPath);

        try {
            if (!fs.existsSync(absNewPath)) {
                fs.mkdirSync(absNewPath, { recursive: true });
            }
            if (context && context.settings) {
                context.settings.project_path = absNewPath;
                saveSettings(context.settings);
            }
            try {
                await saveOllamaCliConfig({ projectPath: absNewPath });
            } catch {}

            console.log(`📁 Project path updated and saved to app_settings.json: "${absNewPath}"`);
            if (context && Array.isArray(context.messages)) {
                context.messages.push({
                    role: "system",
                    content: `[Project Path Changed]: "${absNewPath}"`,
                });
                if (context.activeSessionId) {
                    saveSession(context.activeSessionId, context.messages);
                }
            }
            return { handled: true, success: true, projectPath: absNewPath };
        } catch (err) {
            console.log(`⚠️ Failed to update project path: ${err.message || err}`);
            return { handled: true, success: false, error: err.message || err };
        }
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

    // Memory - @remember (scoped to the active character persona; sim-aware)
    if (lower.startsWith("/remember ")) {
        let text = input.slice(10).trim();
        if (!text) {
            console.log("⚠️ Please provide text to remember. Usage: @remember <text>");
            return { handled: true };
        }
        let forcedLang = null;
        try {
            const { extractLanguageFilter } = await import("./language.js");
            const parsed = extractLanguageFilter(text);
            text = parsed.rest;
            forcedLang = parsed.lang || null;
        } catch {}
        if (!text) {
            console.log("⚠️ Please provide text to remember. Usage: @remember <text>");
            return { handled: true };
        }
        let activeCharId = null;
        try { activeCharId = getActiveCharacter(context.characterStore).id; } catch { activeCharId = context?.settings?.active_character || null; }
        const simActive = getActiveSimulation(cliScopeKey(activeCharId || "main"));
        if (simActive) {
            const mem = addSimulationMemory(simActive.slug, { type: "fact", content: text, source: "user_remember_simulation", confidence: 1.0, importance: 0.8, tags: ["simulation", "remember"] });
            console.log(`🎭🧠 Simulation memory saved inside "${simActive.name}" (not global): [${mem.id}] "${text}"`);
            return { handled: true };
        }
        const mem = forcedLang
            ? remember({ content: text, language: forcedLang }, undefined, activeCharId)
            : remember(text, undefined, activeCharId);
        if (context && Array.isArray(context.messages)) {
            context.messages.push({
                role: "system",
                content: `[Persistent Memory Added]: "${text}"`,
            });
            if (context.activeSessionId) {
                saveSession(context.activeSessionId, context.messages, activeCharId);
            }
        }
        console.log(`🧠 Memory saved for "${activeCharId || "shared"}" [lang:${mem.language || "shared"}] & assistant context refreshed: [${mem.id}] "${text}"`);
        return { handled: true };
    }

    // Memory - @memory-langs : per-language pool counts.
    if (lower === "/memory-langs" || lower === "/memory-lang" || lower === "/memories-lang" || lower.startsWith("/memory-langs ") || lower.startsWith("/memory-lang ")) {
        let activeCharId = null;
        try { activeCharId = getActiveCharacter(context.characterStore).id; } catch { activeCharId = context?.settings?.active_character || null; }
        console.log(`\n${formatMemoryLanguageStats(activeCharId)}\n`);
        return { handled: true };
    }

    // Memory - @memories-all [query], @memory-all [query], @list-memories-all [query]
    // Lists ALL active memories (no 15-item cap). Must come before the @memories block.
    // Sim-aware: inside a simulation, shows the simulation archive instead of global DB.
    if (lower === "/memories-all" || lower === "/memory-all" || lower === "/list-memories-all" || lower.startsWith("/memories-all ") || lower.startsWith("/memory-all ") || lower.startsWith("/list-memories-all ")) {
        let query = "";
        if (lower.startsWith("/list-memories-all ")) query = input.slice(19).trim();
        else if (lower.startsWith("/memories-all ")) query = input.slice(14).trim();
        else if (lower.startsWith("/memory-all ")) query = input.slice(12).trim();
        let activeCharId = null;
        try { activeCharId = getActiveCharacter(context.characterStore).id; } catch { activeCharId = context?.settings?.active_character || null; }
        const simActiveAll = getActiveSimulation(cliScopeKey(activeCharId || "main"));
        if (simActiveAll) {
            console.log(`\n${formatSimulationMemories(simActiveAll.slug, query, 10000)}\n`);
            return { handled: true };
        }
        let langAll = null;
        try {
            const { extractLanguageFilter } = await import("./language.js");
            const parsed = extractLanguageFilter(query);
            query = parsed.rest;
            langAll = parsed.lang || null;
        } catch {}
        console.log(`\n${formatMemories(query, 10000, { all: true, characterId: activeCharId, language: langAll || undefined })}\n`);
        return { handled: true };
    }

    // Memory - @memories [query], @memory [query], @list-memories [query]
    // Bare command lists the 15 most recent active memories (previous behavior).
    // Sim-aware: inside a simulation, shows the simulation archive.
    if (lower === "/memories" || lower === "/memory" || lower === "/list-memories" || lower.startsWith("/memories ") || lower.startsWith("/memory ") || lower.startsWith("/list-memories ")) {
        let query = "";
        if (lower.startsWith("/list-memories ")) query = input.slice(15).trim();
        else if (lower.startsWith("/memories ")) query = input.slice(10).trim();
        else if (lower.startsWith("/memory ")) query = input.slice(8).trim();
        let activeCharId = null;
        try { activeCharId = getActiveCharacter(context.characterStore).id; } catch { activeCharId = context?.settings?.active_character || null; }
        const simActive = getActiveSimulation(cliScopeKey(activeCharId || "main"));
        if (simActive) {
            if (query === "--all" || query.toLowerCase() === "all") {
                console.log(`\n${formatSimulationMemories(simActive.slug, "", 10000)}\n`);
                return { handled: true };
            }
            console.log(`\n${formatSimulationMemories(simActive.slug, query, 15)}\n`);
            return { handled: true };
        }
        if (query === "--all" || query.toLowerCase() === "all") {
            console.log(`\n${formatMemories("", 10000, { all: true, characterId: activeCharId })}\n`);
            return { handled: true };
        }
        let langFilter = null;
        try {
            const { extractLanguageFilter } = await import("./language.js");
            const parsed = extractLanguageFilter(query);
            query = parsed.rest;
            langFilter = parsed.lang || null;
        } catch {}
        console.log(`\n${formatMemories(query, 15, { characterId: activeCharId, language: langFilter || undefined })}\n`);
        return { handled: true };
    }

    // Memory - @forget or @delete-memory (scoped to active character; sim-aware)
    if (lower.startsWith("/delete-memory ") || lower.startsWith("/forget ")) {
        const target = (lower.startsWith("/delete-memory ") ? input.slice(15) : input.slice(8)).trim();
        let activeCharId = null;
        try { activeCharId = getActiveCharacter(context.characterStore).id; } catch { activeCharId = context?.settings?.active_character || null; }
        const simForget = getActiveSimulation(cliScopeKey(activeCharId || "main"));
        if (simForget) {
            const { deleteSimulationMemory } = await import("./simulation.js");
            const res = deleteSimulationMemory(simForget.slug, target);
            console.log(res.success ? `🎭🗑 Simulation memory removed from "${simForget.name}": "${res.removed.content}"` : `⚠️ ${res.message}`);
            return { handled: true };
        }
        const res = deleteMemory(target, undefined, activeCharId);
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
            console.log(`🗑 Memory deactivated/forgotten & context refreshed: "${res.removed.text}"`);
        } else {
            console.log(`⚠️ ${res.message}`);
        }
        return { handled: true };
    }

    // Memory - @neuromorphic-memory / @nc-mem (plasticity layer over Eliza memory)
    if (lower === "/neuromorphic-memory" || lower === "/nc-mem" || lower.startsWith("/neuromorphic-memory ") || lower.startsWith("/nc-mem ")) {
        const nmRes = handleNeuromorphicCommand(rawInput, context && context.settings, saveSettings);
        if (nmRes.handled) {
            console.log(`\n${nmRes.reply}\n`);
            return { handled: true };
        }
    }

    // Memory - @update-memory (scoped to active character; sim-aware)
    if (lower.startsWith("/update-memory ")) {
        const parts = input.slice(15).trim().split(/\s+/);
        const target = parts[0];
        const newText = parts.slice(1).join(" ");
        if (!target || !newText) {
            console.log("⚠️ Usage: @update-memory <index|id> <new text>");
            return { handled: true };
        }
        let activeCharId = null;
        try { activeCharId = getActiveCharacter(context.characterStore).id; } catch { activeCharId = context?.settings?.active_character || null; }
        const simUpd = getActiveSimulation(cliScopeKey(activeCharId || "main"));
        if (simUpd) {
            const { updateSimulationMemory } = await import("./simulation.js");
            const res = updateSimulationMemory(simUpd.slug, target, newText);
            console.log(res.success ? `🎭✏️ Simulation memory updated in "${simUpd.name}": #${target} -> "${res.memory.content}"` : `⚠️ ${res.message}`);
            return { handled: true };
        }
        const res = updateMemory(target, newText, activeCharId);
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

    // Memory - @correct <text> (scoped to active character; sim-aware)
    if (lower.startsWith("/correct ") || lower === "/correct") {
        const statement = input.slice(8).trim();
        if (!statement) {
            console.log("⚠️ Usage: @correct <corrected statement or fact>");
            return { handled: true };
        }
        let activeCharId = null;
        try { activeCharId = getActiveCharacter(context.characterStore).id; } catch { activeCharId = context?.settings?.active_character || null; }
        const simCorr = getActiveSimulation(cliScopeKey(activeCharId || "main"));
        if (simCorr) {
            const mem = addSimulationMemory(simCorr.slug, { type: "correction", content: `User correction: ${statement}`, source: "user_explicit_correction_simulation", confidence: 0.99, importance: 0.95, tags: ["correction", "simulation"] });
            console.log(`🎭✅ Simulation correction recorded inside "${simCorr.name}": [${mem.id}] "${statement}"`);
            return { handled: true };
        }
        const memStore = getMemoryStore(activeCharId);
        const mem = memStore.addMemory({
            type: "correction",
            content: `User correction: ${statement}`,
            source: "user_explicit_correction",
            confidence: 0.99,
            importance: 0.95,
            tags: ["correction"],
        }, activeCharId);
        if (context && Array.isArray(context.messages)) {
            context.messages.push({
                role: "system",
                content: `[User Correction Stored]: "${statement}"`,
            });
            if (context.activeSessionId) {
                saveSession(context.activeSessionId, context.messages);
            }
        }
        console.log(`✅ Correction recorded & conflicting memories superseded: [${mem.id}] "${statement}"`);
        return { handled: true };
    }

    // Knowledge - @knowledge [query] or @list-knowledge
    if (lower === "/knowledge" || lower === "/list-knowledge" || lower.startsWith("/knowledge ")) {
        const query = lower.startsWith("/knowledge ") ? input.slice(11).trim() : "";
        console.log(`\n${formatKnowledge(query)}\n`);
        return { handled: true };
    }

    // Knowledge - @teach <title: content> or @teach <content>
    if (lower.startsWith("/teach ") || lower === "/teach") {
        const arg = input.slice(7).trim();
        if (!arg) {
            console.log("⚠️ Usage: @teach <Title>: <Content> or @teach <Concept description>");
            return { handled: true };
        }
        let title = "Concept";
        let content = arg;
        if (arg.includes(":")) {
            const split = arg.split(":");
            title = split[0].trim();
            content = split.slice(1).join(":").trim();
        } else if (arg.length > 30) {
            title = arg.substring(0, 30).trim() + "...";
        }
        const knStore = new KnowledgeStore();
        const kn = knStore.addKnowledge({
            title,
            content,
            category: "concept",
            sourceType: "user",
            confidence: 1.0,
            changeReason: "User explicit @teach command",
        });
        if (context && Array.isArray(context.messages)) {
            context.messages.push({
                role: "system",
                content: `[Knowledge Added]: "${kn.title}" (v${kn.version})`,
            });
            if (context.activeSessionId) {
                saveSession(context.activeSessionId, context.messages);
            }
        }
        console.log(`📚 Knowledge saved: [${kn.id}] "${kn.title}" (v${kn.version})`);
        return { handled: true };
    }

    // Knowledge - @knowledge-history <id>
    if (lower.startsWith("/knowledge-history ")) {
        const targetId = input.slice(19).trim();
        const knStore = new KnowledgeStore();
        const history = knStore.getVersionHistory(targetId);
        if (history.length === 0) {
            console.log(`⚠️ Knowledge entry "${targetId}" not found.`);
            return { handled: true };
        }
        console.log(`\n📜 Version History for Knowledge Entry "${history[0].title}":`);
        for (const h of history) {
            console.log(`  • Version ${h.version} [${h.id}] (${h.status}) - ${h.createdAt}`);
            console.log(`    Reason: ${h.changeReason || "N/A"}`);
            console.log(`    Content: ${h.content}\n`);
        }
        return { handled: true };
    }

    // Knowledge - @delete-knowledge <id>
    if (lower.startsWith("/delete-knowledge ")) {
        const targetId = input.slice(18).trim();
        const knStore = new KnowledgeStore();
        knStore.deleteKnowledge(targetId);
        console.log(`🗑 Knowledge entry "${targetId}" deprecated.`);
        return { handled: true };
    }

    // Stats - @stats or @learning-stats
    if (lower === "/stats" || lower === "/learning-stats" || lower === "/get-stats") {
        const stats = getLearningStats();
        console.log(`\n=======================================================`);
        console.log(`📊 AI Bot Persistent Learning & Database Stats:`);
        console.log(`-------------------------------------------------------`);
        console.log(`🧠 Active Memories:     ${stats.activeMemories}`);
        console.log(`🔄 Superseded Memories: ${stats.supersededMemories}`);
        console.log(`🗑 Forgotten Memories:  ${stats.forgottenMemories}`);
        console.log(`📦 Total Memories:      ${stats.totalMemories}`);
        if (Array.isArray(stats.memoriesByCharacter) && stats.memoriesByCharacter.length > 0) {
            console.log(`-------------------------------------------------------`);
            console.log(`🎭 Memories by Character (owner → status: count):`);
            for (const row of stats.memoriesByCharacter) {
                console.log(`  • ${row.characterId}: ${row.status} × ${row.count}`);
            }
            console.log(`  (Each bot only sees its own + shared memories.)`);
        }
        if (Array.isArray(stats.memoriesByLanguage) && stats.memoriesByLanguage.length > 0) {
            console.log(`-------------------------------------------------------`);
            console.log(`🌐 Memories by Language (pool → status: count):`);
            for (const row of stats.memoriesByLanguage) {
                console.log(`  • ${row.language}: ${row.status} × ${row.count}`);
            }
            console.log(`  (Each turn uses its own language pool + shared; see @memory-langs.)`);
        }
        console.log(`-------------------------------------------------------`);
        console.log(`📚 Active Knowledge:    ${stats.activeKnowledge}`);
        console.log(`📁 Deprecated Versions: ${stats.deprecatedKnowledge}`);
        console.log(`✍️ User Corrections:    ${stats.corrections}`);
        console.log(`🎯 Active Rules:        ${stats.activeRules}`);
        console.log(`💡 Candidate Rules:     ${stats.candidateRules}`);
        console.log(`📜 Learning Events:     ${stats.totalLearningLogs}`);
        if (stats.neuromorphic) {
            const n = stats.neuromorphic;
            console.log(`-------------------------------------------------------`);
            console.log(`🧠 Neuromorphic Memory (plasticity layer):`);
            console.log(`  Enabled:        ${n.enabled}`);
            console.log(`  Traces:         ${n.traceCount} (avg activation ${n.avgActivation}, high ${n.highActivationMemories})`);
            console.log(`  Hebbian links:  ${n.synapseCount} (max ${n.maxSynapsesPerMemory}/memory)`);
            console.log(`  Decay:          ${n.decayRate}/day | Spike: ${n.spikeAmount} | Assoc: ${n.associationBoost}`);
        }
        if (stats.strategies && stats.strategies.length > 0) {
            console.log(`-------------------------------------------------------`);
            console.log(`📈 Strategy Stats:`);
            for (const s of stats.strategies) {
                console.log(`  • ${s.strategy.padEnd(16)}: ${s.attempts} attempts | ${s.successes} successes | avg score: ${s.avgScore}`);
            }
        }
        console.log(`=======================================================\n`);
        return { handled: true };
    }

    // Learning Logs - @learning-logs
    if (lower.startsWith("/learning-logs") || lower === "/learning-logs") {
        const limitStr = input.slice(14).trim();
        const limit = parseInt(limitStr, 10) || 15;
        const logs = getLearningLogs(limit);
        if (logs.length === 0) {
            console.log("📜 No learning logs recorded yet.");
            return { handled: true };
        }
        console.log(`\n📜 Recent Incremental Learning Logs (${logs.length}):`);
        for (const l of logs) {
            console.log(`  • [${l.timestamp.slice(0, 19)}] [${l.eventType}]: ${JSON.stringify(l.details)}`);
        }
        console.log("");
        return { handled: true };
    }

    // Learning Toggle - @set-learning [on|off] or @auto-learning
    if (lower.startsWith("/set-learning ") || lower.startsWith("/auto-learning ")) {
        const valStr = input.split(/\s+/)[1]?.toLowerCase();
        const enabled = valStr === "on" || valStr === "true" || valStr === "1" || valStr === "enable";
        if (context && context.settings) {
            setSetting("auto_learning_enabled", enabled, context.settings);
            console.log(`🧠 Automatic Background LLM Learning Extraction: ${enabled ? "ENABLED" : "DISABLED"}`);
        }
        return { handled: true };
    }

    // Rules - @rules [status]
    if (lower.startsWith("/rules") || lower === "/rules" || lower === "/candidate-rules") {
        const status = lower.startsWith("/rules ") ? input.slice(7).trim() : (lower === "/candidate-rules" ? "candidate" : null);
        const pipeline = getLearningPipeline();
        const rules = pipeline.listRules(status);
        if (rules.length === 0) {
            console.log(`📋 No ${status ? status + " " : ""}rules found.`);
            return { handled: true };
        }
        console.log(`\n📋 Learned Pattern Rules (${rules.length}):`);
        for (const r of rules) {
            console.log(`  • [${r.id}] [${r.status.toUpperCase()}] Priority: ${r.priority} | Keywords: ${r.keywords.join(", ")}`);
            console.log(`    Patterns: ${r.patterns.join(", ")}`);
            console.log(`    Responses: ${r.responses.join(" | ")}`);
            if (r.sourceReason) console.log(`    Reason: ${r.sourceReason}`);
            console.log("");
        }
        return { handled: true };
    }

    // Rules - @approve-rule <id>
    if (lower.startsWith("/approve-rule ")) {
        const ruleId = input.slice(14).trim();
        const pipeline = getLearningPipeline();
        pipeline.approveRule(ruleId);
        console.log(`✅ Rule "${ruleId}" approved and activated.`);
        return { handled: true };
    }

    // Tasks - @register-task or @task
    if (lower.startsWith("/register-task ") || lower.startsWith("/task ")) {
        const text = input.startsWith("/register-task ") ? input.slice(15).trim() : input.slice(6).trim();
        if (!text) {
            console.log("⚠️ Usage: @register-task <description>");
            return { handled: true };
        }
        const task = registerTask(text, "p");
        console.log(`📋 Task "#${task.id}" registered into Processing (p) status.`);
        return { handled: true };
    }

    // Tasks - @get-tasks, @tasks
    if (lower === "/get-tasks" || lower === "/tasks") {
        console.log(`\n${formatActiveTasks()}\n`);
        return { handled: true };
    }

    // Tasks - @all-tasks
    if (lower === "/all-tasks") {
        console.log(`\n${formatAllTasks()}\n`);
        return { handled: true };
    }

    // Tasks - Move Task regex: @move-task-1-o or @move-task 1 o
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

    // Tasks - Delete Task regex: @delete-task-1 or @delete-task 1
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
            console.log("⚠️ Usage: @set-task-reminder <minutes>");
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
            if (SECURITY_PIN_KEYS.includes(k)) {
                valStr = v ? "(set — use @set-security-pin to change, @remove-security-pin to clear)" : "(not set)";
            } else if (OTP_KEYS.includes(k)) {
                valStr = k === "otp_secret"
                    ? (v ? "(enrolled — use @otp-set to rotate, @otp-remove to clear; never displayed)" : "(not enrolled)")
                    : (v ? String(v) : "(not set)");
            } else if (k.endsWith("_key") && v) valStr = maskApiKey(v);
            console.log(`  • ${k}: ${valStr}`);
        }
        if (isSecurityPinSet(context.settings) || isOtpSet(context.settings)) {
            const pinBit = isSecurityPinSet(context.settings)
                ? (isScopeUnlocked(CLI_SCOPE) ? "PIN unlocked (@lock to re-lock)" : "PIN locked (@unlock <pin>)")
                : "PIN not set";
            const otpBit = isOtpSet(context.settings)
                ? (isOtpAuthenticated(CLI_SCOPE) ? "OTP authenticated (@otp-lock to drop)" : "OTP NOT authenticated (@otp-login <code>)")
                : "OTP not enrolled";
            console.log(`  🔒 Control commands on this surface: ${pinBit}; ${otpBit}`);
        }
        console.log("\n💡 Change any setting using specific commands or @set-setting <key> <value>\n");
        return { handled: true };
    }

    if (lower.startsWith("/set-setting ")) {
        const parts = input.split(/\s+/);
        const key = parts[1];
        let valStr = parts.slice(2).join(" ");
        if (!key || valStr === undefined || valStr === "") {
            console.log("⚠️ Usage: @set-setting <key> <value>");
            return { handled: true };
        }
        if (SECURITY_PIN_KEYS.includes(key)) {
            console.log("⛔ That key is managed by the security PIN commands — use @set-security-pin <6+ digits> to set it or @remove-security-pin <pin> to clear it.");
            return { handled: true };
        }
        if (OTP_KEYS.includes(key)) {
            console.log("⛔ That key is managed by the OTP commands — use @otp-set to enroll or @otp-remove <code> to clear it (never via @set-setting).");
            return { handled: true };
        }
        if (key === "security_unlock_minutes") {
            const mins = Number(valStr);
            if (!Number.isFinite(mins) || mins < 1 || mins > 1440) {
                console.log("⚠️ Usage: @set-setting security_unlock_minutes <1-1440>");
                return { handled: true };
            }
            valStr = String(Math.floor(mins));
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
            console.log("⚠️ Usage: @set-server-url <http_url>");
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
            console.log("⚠️ Usage: @set-mem-limit <number_of_messages>");
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
            console.log("⚠️ Usage: @set-workspace <workspace_name>");
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

    // API Keys - @set-api-key <provider> <key>
    if (lower.startsWith("/set-api-key ") || lower.startsWith("/set-key ")) {
        const parts = input.split(/\s+/);
        const provider = (parts[1] || "").toLowerCase();
        const key = parts.slice(2).join(" ").trim();

        if (!provider || !key) {
            console.log("⚠️ Usage: @set-api-key <openai|gemini|claude|grok|mistral|youtube|spotify|wordpress|blogger|semanticscholar|brave|tavily> <api_key>");
            console.log("   Spotify takes two parts: @set-api-key spotify <client_id> <client_secret>");
            console.log("   WordPress takes three parts: @set-api-key wordpress <site_url> <username> <app_password>");
            console.log("   Blogger takes two parts: @set-api-key blogger <blog_id> <access_token>");
            console.log("   Semantic Scholar takes one part: @set-api-key semanticscholar <api_key> (optional, raises @fact-check rate limits)");
            console.log("   Brave/Tavily take one part: @set-api-key brave|tavily <api_key> (optional, upgrades live web search; DuckDuckGo works without a key)");
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
        } else if (["mistral", "mistralai", "mistral-ai"].includes(provider)) {
            context.settings.mistral_api_key = key;
            saveSettings(context.settings);
            console.log(`🔑 Saved Mistral AI API Key: ${maskApiKey(key)}`);
        } else if (["youtube", "google-youtube", "yt"].includes(provider)) {
            context.settings.youtube_api_key = key;
            saveSettings(context.settings);
            console.log(`🔑 Saved YouTube Data API Key: ${maskApiKey(key)} (default engine for @youtube-play/@play)`);
        } else if (["spotify"].includes(provider)) {
            const creds = key.split(/\s+/).filter(Boolean);
            if (creds.length < 2) {
                console.log("⚠️ Usage: @set-api-key spotify <client_id> <client_secret>");
                return { handled: true };
            }
            context.settings.spotify_client_id = creds[0];
            context.settings.spotify_client_secret = creds.slice(1).join(" ");
            saveSettings(context.settings);
            console.log(`🔑 Saved Spotify API credentials: id=${maskApiKey(creds[0])} (default engine for @spotify-play/@spotify)`);
        } else if (["wordpress", "wp"].includes(provider)) {
            const parts = key.split(/\s+/).filter(Boolean);
            if (parts.length < 3) {
                console.log("⚠️ Usage: @set-api-key wordpress <site_url> <username> <app_password>");
                return { handled: true };
            }
            context.settings.wordpress_site_url = parts[0].replace(/\/+$/, "");
            context.settings.wordpress_username = parts[1];
            context.settings.wordpress_app_password = parts.slice(2).join(" ");
            saveSettings(context.settings);
            console.log(`🔑 Saved WordPress API credentials: ${context.settings.wordpress_site_url} as ${context.settings.wordpress_username} (default engine for @blog/@wordpress)`);
        } else if (["blogger", "blogspot", "blog"].includes(provider)) {
            const parts = key.split(/\s+/).filter(Boolean);
            if (parts.length < 2) {
                console.log("⚠️ Usage: @set-api-key blogger <blog_id> <access_token>");
                return { handled: true };
            }
            context.settings.blogger_blog_id = parts[0];
            context.settings.blogger_access_token = parts.slice(1).join(" ");
            saveSettings(context.settings);
            console.log(`🔑 Saved Blogger API credentials: blog=${maskApiKey(parts[0])} (default engine for @blog/@blogger)`);
        } else if (["semanticscholar", "semantic-scholar", "semanticscholar-api", "factcheck", "fact-check"].includes(provider)) {
            context.settings.semantic_scholar_api_key = key;
            saveSettings(context.settings);
            console.log(`🔑 Saved Semantic Scholar API Key: ${maskApiKey(key)} (raises @fact-check rate limits; anonymous access also works)`);
        } else if (["brave", "brave-search", "bravesearch"].includes(provider)) {
            context.settings.brave_api_key = key;
            saveSettings(context.settings);
            console.log(`🔑 Saved Brave Search API Key: ${maskApiKey(key)} (upgrades live web search engine; auto-selected when set)`);
        } else if (["tavily", "tavily-ai", "tavilyai"].includes(provider)) {
            context.settings.tavily_api_key = key;
            saveSettings(context.settings);
            console.log(`🔑 Saved Tavily Search API Key: ${maskApiKey(key)} (upgrades live web search engine; auto-selected when set)`);
        } else {
            console.log("⚠️ Unknown provider. Supported providers: openai, gemini, claude, grok, mistral, youtube, spotify, wordpress, blogger, semanticscholar, brave, tavily");
        }
        return { handled: true };
    }

    // API Keys - @api-keys (list configured keys)
    if (lower === "/api-keys" || lower === "/keys") {
        console.log("\n🔑 Configured Multi-Provider API Keys:");
        const providers = [
            { name: "OpenAI (ChatGPT)", keySetting: context.settings.openai_api_key, envVars: ["OPENAI_API_KEY", "CHATGPT_API_KEY"] },
            { name: "Google Gemini", keySetting: context.settings.gemini_api_key, envVars: ["GEMINI_API_KEY"] },
            { name: "Anthropic Claude", keySetting: context.settings.claude_api_key, envVars: ["CLAUDE_API_KEY", "ANTHROPIC_API_KEY"] },
            { name: "xAI Grok", keySetting: context.settings.grok_api_key, envVars: ["GROK_API_KEY", "XAI_API_KEY"] },
            { name: "Mistral AI", keySetting: context.settings.mistral_api_key, envVars: ["MISTRAL_API_KEY"] },
            { name: "YouTube Data API (default @play engine)", keySetting: context.settings.youtube_api_key, envVars: ["YOUTUBE_API_KEY", "YOUTUBE_DATA_API_KEY"] },
            { name: "Spotify Client ID (default @spotify engine)", keySetting: context.settings.spotify_client_id, envVars: ["SPOTIFY_CLIENT_ID"] },
            { name: "Spotify Client Secret", keySetting: context.settings.spotify_client_secret, envVars: ["SPOTIFY_CLIENT_SECRET"] },
            { name: "WordPress Site URL (default @blog/@wordpress engine)", keySetting: context.settings.wordpress_site_url, envVars: ["WORDPRESS_SITE_URL", "WORDPRESS_URL"] },
            { name: "WordPress Username", keySetting: context.settings.wordpress_username, envVars: ["WORDPRESS_USERNAME"] },
            { name: "WordPress App Password", keySetting: context.settings.wordpress_app_password, envVars: ["WORDPRESS_APP_PASSWORD", "WORDPRESS_PASSWORD"] },
            { name: "Blogger Blog ID (default @blog/@blogger engine)", keySetting: context.settings.blogger_blog_id, envVars: ["BLOGGER_BLOG_ID"] },
            { name: "Blogger Access Token (OAuth2)", keySetting: context.settings.blogger_access_token, envVars: ["BLOGGER_ACCESS_TOKEN", "BLOGGER_OAUTH_TOKEN"] },
            { name: "Semantic Scholar API Key (@fact-check, optional)", keySetting: context.settings.semantic_scholar_api_key, envVars: ["SEMANTIC_SCHOLAR_API_KEY"] },
            { name: "Brave Search API Key (live web search, optional)", keySetting: context.settings.brave_api_key, envVars: ["BRAVE_API_KEY"] },
            { name: "Tavily Search API Key (live web search, optional)", keySetting: context.settings.tavily_api_key, envVars: ["TAVILY_API_KEY"] },
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
        const ps = getPlayStatus(context.settings);
        console.log(`\n▶️ Play engine: ${ps.source} (youtube API ${ps.youtubeApi ? "configured" : "missing — Chromium fallback"}; spotify API ${ps.spotifyApi ? "configured" : "missing — Chromium fallback"})`);
        console.log("💡 Switch engine: @set-setting play_source <auto|api|browser>");
        const bs = getBlogStatus(context.settings);
        console.log(`📝 Blog engine: ${bs.source} (wordpress API ${bs.wordpressApi ? "configured" : "missing — Chromium fallback"}; blogger API ${bs.bloggerApi ? "configured" : "missing — Chromium fallback"})`);
        console.log("💡 Switch engine: @set-setting blog_source <auto|api|browser>");
        const fs = getFactCheckStatus(context.settings);
        console.log(`🔍 Fact-check engine: ${fs.source} (papers ${fs.papersApi ? "API key set" : "anonymous access"}; gemini verdict ${fs.gemini ? `configured (${fs.geminiModel})` : "missing — papers only"})`);
        console.log("💡 Switch engine: @set-setting factcheck_source <auto|papers|gemini>");
        console.log(`🪡 Needle on-device: ${isNeedleAutoRoutingEnabled(context.settings) ? "auto-routing on" : "manual @needle commands"} (threshold ${getNeedleMinConfidence(context.settings)}; status: @needle-status)\n`);
        return { handled: true };
    }

    // Models - @models (list local & cloud models across all providers)
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
            { id: "mistral", title: "Mistral AI", models: DEFAULT_MODELS.mistral },
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

        console.log("\n💡 Switch active model using: @model <model-name>");
        console.log("💡 Set provider API keys using: @set-api-key <provider> <key>\n");
        return { handled: true };
    }

    // Model - @model
    if (lower === "/model" || lower.startsWith("/model ")) {
        const targetModel = input.slice(6).trim();
        if (!targetModel) {
            const currentModel = getSharedModel(context.settings);
            const provider = detectProvider(currentModel);
            console.log(`🤖 Current Model: ${currentModel} (Provider: ${provider})`);
            return { handled: true };
        }
        await setSharedModel(context.settings, context.characterStore, targetModel);
        const provider = detectProvider(targetModel);
        console.log(`🤖 Model updated to: ${targetModel} (Provider: ${provider})`);
        return { handled: true };
    }

    // Characters - @characters
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

    // Character - @character
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
            saveSettings(context.settings);
            console.log(`🎭 Switched active character profile to "${res.activeCharacter.name}"`);
            try {
                const bridge = context.personaBridge;
                if (bridge && typeof bridge.ensurePersona === "function") {
                    const woken = await bridge.ensurePersona(res.activeCharacter.id, "character-switch");
                    if (woken && woken.started) console.log(`🔌 Polling started for "${res.activeCharacter.name}" (previous personas idle-release after timeout).`);
                    else if (woken && woken.reason === "no-token") console.log(`🔌 Note: "${res.activeCharacter.name}" has no Telegram token — polling paused for it.`);
                }
            } catch {}
        } else {
            console.log(`⚠️ ${res.message}`);
        }
        return { handled: true };
    }

    // Persona polling bridge - @polling-status
    if (lower === "/polling-status" || lower === "/polling" || lower === "/pollers") {
        try {
            const bridge = context.personaBridge;
            if (bridge && typeof bridge.formatStatus === "function") {
                console.log(`\n${bridge.formatStatus()}\n`);
            } else {
                console.log("\n🔌 Persona polling bridge not initialized in this session.\n");
            }
        } catch (err) {
            console.log(`⚠️ Polling status error: ${err.message || err}`);
        }
        return { handled: true };
    }

    // Persona polling bridge - @wake <name|id>
    if (lower === "/wake" || lower.startsWith("/wake ")) {
        const target = input.slice(5).trim();
        if (!target) {
            console.log("⚠️ Usage: @wake <character name|id>");
            return { handled: true };
        }
        try {
            const bridge = context.personaBridge;
            if (!bridge || typeof bridge.ensurePersona !== "function") {
                console.log("⚠️ Persona polling bridge not initialized in this session.");
                return { handled: true };
            }
            const res = await bridge.ensurePersona(target, "manual-wake");
            if (res && res.runner) {
                console.log(res.started ? `🔌 Polling started for "${res.character?.name || target}".` : `🔌 "${res.character?.name || target}" is already polling.`);
            } else {
                console.log(`⚠️ Cannot wake "${target}": ${res?.reason || "no Telegram token configured"}.`);
            }
        } catch (err) {
            console.log(`⚠️ Wake error: ${err.message || err}`);
        }
        return { handled: true };
    }

    // Persona polling bridge - @sleep <name|id>
    if (lower === "/sleep" || lower.startsWith("/sleep ")) {
        const target = input.slice(6).trim();
        if (!target) {
            console.log("⚠️ Usage: @sleep <character name|id>");
            return { handled: true };
        }
        try {
            const bridge = context.personaBridge;
            if (!bridge || typeof bridge.sleepPersona !== "function") {
                console.log("⚠️ Persona polling bridge not initialized in this session.");
                return { handled: true };
            }
            const res = await bridge.sleepPersona(target);
            console.log(res.success ? `🔌 ${res.message}` : `⚠️ ${res.message}`);
        } catch (err) {
            console.log(`⚠️ Sleep error: ${err.message || err}`);
        }
        return { handled: true };
    }

    // Persona polling bridge - @set-polling-idle <minutes>
    if (lower.startsWith("/set-polling-idle ") || lower.startsWith("/polling-idle ")) {
        const raw = input.split(/\s+/)[1];
        const mins = Number(raw);
        if (!Number.isFinite(mins) || mins < 0) {
            console.log("⚠️ Usage: @set-polling-idle <minutes> (0 disables auto-sleep)");
            return { handled: true };
        }
        context.settings.persona_idle_timeout_minutes = mins;
        saveSettings(context.settings);
        console.log(`🔌 Persona idle auto-sleep timeout set to ${mins} minute(s) and saved to app_settings.json.`);
        return { handled: true };
    }

    // Create Character - @create-character Name | Prompt
    if (lower.startsWith("/create-character ")) {
        const payload = input.slice(18).trim();
        const parts = payload.split("|").map((p) => p.trim());
        if (parts.length < 2) {
            console.log("⚠️ Usage: @create-character <Name> | <System Prompt>");
            return { handled: true };
        }
        // Accept the former Name | Model | Prompt form for compatibility; models
        // remain global so the middle value is intentionally ignored.
        const prompt = parts.length >= 3 ? parts[2] : parts[1];
        const newChar = createCharacter(parts[0], getSharedModel(context.settings), prompt, {}, context.characterStore);
        console.log(`🎭 Created new character profile "${newChar.name}" (#${newChar.id}).`);
        return { handled: true };
    }

    // Set Telegram Token - @set-telegram-token <token> [character_id]
    if (lower.startsWith("/set-telegram-token ")) {
        const parts = input.slice(20).trim().split(/\s+/);
        const token = parts[0];
        const charId = parts[1] || context.settings.active_character;
        if (!token) {
            console.log("⚠️ Usage: @set-telegram-token <token> [character_id]");
            return { handled: true };
        }
        const res = updateCharacterToken(context.characterStore, charId, token);
        if (res.success) {
            context.settings.telegram_token = token;
            saveSettings(context.settings);
            console.log(`✈️ Saved Telegram Token to characters.json for persona "${res.character.name}" (${res.character.id}) & app_settings.json.`);
            try {
                const bridge = context.personaBridge;
                const isActive = String(context.characterStore?.active_character || "") === String(res.character.id);
                if (bridge && typeof bridge.ensurePersona === "function" && (isActive || bridge.isRunning(res.character.id))) {
                    await bridge.ensurePersona(res.character.id, "token-update");
                    console.log(`🔌 Polling ensured for "${res.character.name}".`);
                } else if (bridge && typeof bridge.ensurePersona === "function" && isActive) {
                    await bridge.ensurePersona(res.character.id, "token-update");
                }
            } catch {}
        } else {
            console.log(`⚠️ ${res.message}`);
        }
        return { handled: true };
    }

    // Set Persona System Prompt - @set-persona-prompt <prompt> [character_id]
    if (lower.startsWith("/set-persona-prompt ")) {
        const prompt = input.slice(20).trim();
        if (!prompt) {
            console.log("⚠️ Usage: @set-persona-prompt <system prompt text>");
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

    // WhatsApp Phone Pairing Code - @whatsapp-pair <phone_number>
    if (lower.startsWith("/whatsapp-pair ")) {
        const phone = input.slice(15).trim();
        if (!phone) {
            console.log("⚠️ Usage: @whatsapp-pair <phone_number_with_country_code> (e.g. @whatsapp-pair 1234567890)");
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

    // Set WhatsApp Phone - @set-whatsapp-phone <phone_number>
    if (lower.startsWith("/set-whatsapp-phone ") || lower.startsWith("/whatsapp-number ")) {
        const phone = input.startsWith("/set-whatsapp-phone ") ? input.slice(20).trim() : input.slice(17).trim();
        if (!phone) {
            console.log("⚠️ Usage: @set-whatsapp-phone <phone_number_with_country_code>");
            return { handled: true };
        }
        context.settings.whatsapp_phone = phone.replace(/[^0-9]/g, "");
        saveSettings(context.settings);
        console.log(`📱 WhatsApp phone number saved in app_settings.json: +${context.settings.whatsapp_phone}`);
        return { handled: true };
    }

    // Toggle WhatsApp Bridge Enabled - @whatsapp-enabled [on|off] or @set-whatsapp [on|off]
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

    // Reset WhatsApp Auth - @reset-whatsapp-auth
    if (lower === "/reset-whatsapp-auth") {
        const res = resetWhatsAppAuth();
        console.log(`📱 ${res.message}`);
        return { handled: true };
    }

    // Sessions - @sessions
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

    // Sessions - @session <id>
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

    // Sessions - @new-session
    if (lower === "/new-session") {
        const activeChar = getActiveCharacter(context.characterStore);
        const newSession = createSession(activeChar.id);
        context.activeSessionId = newSession.id;
        context.messages = [];
        console.log(`💬 Created fresh chat session [${newSession.id.slice(0, 8)}].`);
        return { handled: true };
    }

    // Sessions - @delete-session
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

    // Sessions - @rename-session
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

    // Notes - @fetch-note-about or @write-about
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

    // PDF Conversion - @convert-pdf or @pdf
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

    // PDF Conversion - @pdf-to-md or @convert-md
    if (lower.startsWith("/pdf-to-md") || lower.startsWith("/convert-md")) {
        const parts = input.split(/\s+/);
        const pdfFile = parts[1] || "";
        if (!pdfFile) {
            console.log("⚠️ Usage: @pdf-to-md <filename.pdf>");
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

    // Local Voice / STT - @voice <audio_file_path>
    if (lower.startsWith("/voice ")) {
        const filePath = input.slice(7).trim();
        if (!filePath) {
            console.log("⚠️ Usage: @voice <path_to_audio_file>");
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

    // Local Voice / TTS - @tts <text>
    if (lower.startsWith("/tts ")) {
        const textToSpeak = input.slice(5).trim();
        if (!textToSpeak) {
            console.log("⚠️ Usage: @tts <text_to_synthesize>");
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

    // Ephemeral one-shot Ollama inference toggle - @ephemeral [on|off|status], @one-shot, @oneshot
    if (lower === "/ephemeral" || lower.startsWith("/ephemeral ") || lower === "/one-shot" || lower.startsWith("/one-shot ") || lower === "/oneshot" || lower.startsWith("/oneshot ")) {
        const { parseEphemeralToggleArg, formatEphemeralReply } = await import("./ollama_ephemeral.js");
        const arg = (input.split(/\s+/)[1] || "");
        const action = parseEphemeralToggleArg(arg);
        if (action === "invalid") {
            console.log("⚠️ Usage: @ephemeral [on|off|status] (or @one-shot)");
            return { handled: true };
        }
        if (action === "on") context.settings.ollama_ephemeral = true;
        else if (action === "off") context.settings.ollama_ephemeral = false;
        saveSettings(context.settings);
        console.log(`\n${formatEphemeralReply(context.settings)}\n`);
        return { handled: true };
    }

    // Local Voice Reply / Voice Mode Toggle - @voice-reply [on|off], @voice-mode [on|off]
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

    // Live web search - @live-web <query> | @live-gemini <query> | @web-search <query> | @websearch <query> | @search-web <query>
    // (explicit forms; the inline "@live-web / @live-gemini within a sentence" trigger is
    // handled in the chat pipelines via runWebSearchForPrompt in src/websearch.js).
    // Must run BEFORE the @web voice-bridge block below (prefix overlap).
    {
        const { parseWebSearchCommand, parseWebFetchCommand, parseWebStatusCommand } = await import("./websearch.js");
        const webStatusCmd = parseWebStatusCommand(rawInput);
        if (webStatusCmd) {
            console.log(`\n${(await import("./websearch.js")).formatWebStatus(context ? context.settings : {})}\n`);
            return { handled: true };
        }
        const webSearchCmd = parseWebSearchCommand(rawInput, context ? context.settings : {});
        if (webSearchCmd) {
            if (!webSearchCmd.query) {
                console.log("⚠️ Usage: @web-search <query> [--provider auto|duckduckgo|brave|tavily|google-ai] [--limit N]");
                console.log("Example: @web-search latest BTC price");
                console.log('Inline forms: @live-web ("latest BTC price @live-web") or @live-gemini ("explain black holes @live-gemini")');
                return { handled: true };
            }
            try {
                const { searchWeb, formatWebResults } = await import("./websearch.js");
                console.log(`🌐 Searching the live web for "${webSearchCmd.query}"...`);
                const res = await searchWeb(webSearchCmd.query, context ? context.settings : {}, {
                    provider: webSearchCmd.provider,
                    maxResults: webSearchCmd.maxResults,
                });
                console.log(`\n${formatWebResults(res)}\n`);
                if (context && Array.isArray(context.messages)) {
                    context.messages.push({ role: "user", content: rawInput });
                    context.messages.push({ role: "assistant", content: formatWebResults(res) });
                    if (context.activeSessionId) saveSession(context.activeSessionId, context.messages);
                }
            } catch (err) {
                console.log(`⚠️ Web search error: ${err.message || err}`);
            }
            return { handled: true };
        }
        const webFetchCmd = parseWebFetchCommand(rawInput);
        if (webFetchCmd) {
            if (!webFetchCmd.url) {
                console.log("⚠️ Usage: @web-fetch <url>");
                console.log("Example: @web-fetch https://example.com/article");
                return { handled: true };
            }
            try {
                const { fetchPageText, formatPageText } = await import("./websearch.js");
                console.log(`📄 Fetching ${webFetchCmd.url}...`);
                const res = await fetchPageText(webFetchCmd.url, context ? context.settings : {});
                console.log(`\n${formatPageText(res)}\n`);
                if (context && Array.isArray(context.messages)) {
                    context.messages.push({ role: "user", content: rawInput });
                    context.messages.push({ role: "assistant", content: formatPageText(res) });
                    if (context.activeSessionId) saveSession(context.activeSessionId, context.messages);
                }
            } catch (err) {
                console.log(`⚠️ Web fetch error: ${err.message || err}`);
            }
            return { handled: true };
        }
    }

    // Real-Time Voice Socket Server & Web UI - @web, @voice-socket, @voice-server, or @dagowan
    // NOTE: "@web" is voice-only (bare, on/off, or anything else). Live web
    // search uses "@live-web" (inline or leading) and "@web-search".
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

    // OpenWebUI-style Dashboard - @dashboard [on|off] [port] (alias @dash)
    if (lower === "/dashboard" || lower.startsWith("/dashboard ") || lower === "/dash" || lower.startsWith("/dash ")) {
        const parts = input.split(/\s+/);
        const rest = parts.slice(1);
        const flag = rest[0] ? rest[0].toLowerCase() : null;
        if (flag && ["off", "disable", "disabled", "false", "0", "stop"].includes(flag)) {
            if (globalDashboardServer) {
                globalDashboardServer.stop();
                globalDashboardServer = null;
            }
            context.settings.dashboard_enabled = false;
            saveSettings(context.settings);
            console.log("📊 Dashboard stopped and disabled in app_settings.json.");
            return { handled: true };
        }
        let port = Number(process.env.DASHBOARD_PORT || context.settings.dashboard_port || 8768);
        for (const token of rest) {
            const n = Number(token);
            if (Number.isFinite(n) && n > 0 && n < 65536) {
                port = n;
                break;
            }
        }
        context.settings.dashboard_enabled = true;
        context.settings.dashboard_port = port;
        saveSettings(context.settings);
        if (!globalDashboardServer) {
            const { DashboardServer } = await import("./dashboard.js");
            globalDashboardServer = new DashboardServer({ settings: context.settings, characterStore: context.characterStore });
            globalDashboardServer.start(port);
        } else {
            console.log(`📊 Dashboard is already running on http://127.0.0.1:${globalDashboardServer.port || port}`);
        }
        console.log("📊 Dashboard enabled status saved to app_settings.json.");
        return { handled: true };
    }

    // Agentic local browser - @youtube-play <query|url> [--no-show] (alias @play)
    // Default: official YouTube Data API + host handoff; Chromium is the fallback.
    if (lower.startsWith("/youtube-play") || lower === "/play" || lower.startsWith("/play ")) {
        const parsed = parsePlayInput(input) || { query: "", show: true };
        const show = parsed.show;
        const query = parsed.query;
        if (!query) {
            console.log("⚠️ Usage: @youtube-play <search terms or YouTube URL> [--no-show]");
            console.log("Example: @youtube-play lofi hip hop radio");
            return { handled: true };
        }
        try {
            const st = getPlayStatus(context ? context.settings : {});
            console.log(`▶️ Playing YouTube for "${query}" via ${st.youtubeApi ? "YouTube Data API" : "local browser fallback"}...`);
            const res = await playYoutubeViaApi(query, context ? context.settings : {}, { show });
            if (res.success) {
                const handoff = res.shown
                    ? "🖥 Opened in your default browser."
                    : (show ? `⚠️ Default-browser handoff failed${res.showError ? `: ${res.showError}` : ""} — video is loaded in the controlled window.` : "");
                const via = res.source === "api" ? " (via YouTube Data API)" : (res.source === "browser" ? " (via local browser fallback)" : "");
                console.log(`▶️ Now playing: "${res.title || "YouTube video"}"${via}\n🔗 ${res.url}\n▶️ Playback state: ${res.playing ? "playing" : "loaded"}\n${handoff}`.trimEnd());
                if (context && Array.isArray(context.messages)) {
                    context.messages.push({ role: "user", content: input });
                    context.messages.push({ role: "assistant", content: `▶️ Playing "${res.title || "YouTube video"}" (${res.url}).` });
                    if (context.activeSessionId) saveSession(context.activeSessionId, context.messages);
                }
            } else {
                console.log(`⚠️ Browser playback error: ${res.error}`);
            }
        } catch (err) {
            console.log(`⚠️ Browser playback error: ${err.message || err}`);
        }
        return { handled: true };
    }

    // Agentic local browser - @spotify-play <query|url> [--no-show] (alias @spotify, songs + podcasts)
    // Default: official Spotify Web API + host handoff; Chromium is the fallback.
    if (lower.startsWith("/spotify-play") || lower === "/spotify" || lower.startsWith("/spotify ")) {
        const parsed = parseSpotifyPlayInput(input) || { query: "", show: true };
        const show = parsed.show;
        const query = parsed.query;
        if (!query) {
            console.log("⚠️ Usage: @spotify-play <search terms or Spotify URL> [--no-show]");
            console.log("Example: @spotify-play lofi hip hop");
            console.log("Example: @spotify-play Serial podcast");
            return { handled: true };
        }
        try {
            const st = getPlayStatus(context ? context.settings : {});
            console.log(`🎧 Playing Spotify for "${query}" via ${st.spotifyApi ? "Spotify Web API" : "local browser fallback"}...`);
            const res = await playSpotifyViaApi(query, context ? context.settings : {}, { show });
            if (res.success) {
                console.log(formatSpotifyPlayResult(res));
                if (context && Array.isArray(context.messages)) {
                    context.messages.push({ role: "user", content: input });
                    context.messages.push({ role: "assistant", content: `🎧 Playing "${res.title || "Spotify track"}" (${res.url}).` });
                    if (context.activeSessionId) saveSession(context.activeSessionId, context.messages);
                }
            } else {
                console.log(`⚠️ Spotify playback error: ${res.error}`);
            }
        } catch (err) {
            console.log(`⚠️ Spotify playback error: ${err.message || err}`);
        }
        return { handled: true };
    }

    // Blogger OAuth - @blogger-auth [client_secret_file] (CLI only: the
    // consent callback must reach this machine's loopback server).
    if (lower === "/blogger-auth" || lower.startsWith("/blogger-auth ")) {
        const fileArg = input.slice("/blogger-auth".length).trim();
        const redirectUri = bloggerAuthRedirectUri(context ? context.settings : {});
        console.log(`🔑 Blogger OAuth setup (one Cloud Console step first): register this EXACT Authorized redirect URI on your OAuth client (copy it character-for-character — localhost and 127.0.0.1 are different):\n   ${redirectUri || BLOGGER_AUTH_REDIRECT_URI}`);
        try {
            const patch = await runBloggerAuthFlow(context ? context.settings : {}, {
                clientFile: fileArg,
                redirectUri,
                onUrl: (url) => {
                    console.log(`\n🔑 Approve Blogger access in your browser (waiting up to 3 min):\n${url}\n`);
                    try {
                        new AgenticModule().openUrl(url);
                    } catch {}
                },
            });
            const { authUrl: _dropped, ...save } = patch;
            if (context && context.settings) {
                Object.assign(context.settings, save);
                saveSettings(context.settings);
            }
            console.log(`✅ Blogger connected — access token stored${save.blogger_refresh_token ? " with refresh token (auto-refresh enabled)" : " (no refresh token issued; re-run with consent if it expires)"}. Try: @blog hello world on blogger`);
            if (context && Array.isArray(context.messages)) {
                context.messages.push({ role: "user", content: input });
                context.messages.push({ role: "assistant", content: "✅ Blogger OAuth connected (token stored, auto-refresh enabled)." });
                if (context.activeSessionId) saveSession(context.activeSessionId, context.messages);
            }
        } catch (err) {
            console.log(`⚠️ Blogger auth error: ${err.message || err}`);
        }
        return { handled: true };
    }

    // Agentic local browser - @blog <topic> [--on wordpress|blogger] [--title ...] [--no-show]
    // (aliases @wordpress, @blogger, @post). Default: official WordPress REST /
    // Blogger v3 APIs + host handoff; Chromium editor automation is the fallback.
    if (lower === "/blog" || lower.startsWith("/blog ") || lower.startsWith("/blog-") ||
        lower === "/blogpost" || lower.startsWith("/blogpost ") ||
        lower === "/post" || lower.startsWith("/post ") ||
        lower === "/wordpress" || lower.startsWith("/wordpress ") || lower === "/wp" || lower.startsWith("/wp ") ||
        lower === "/blogger" || lower.startsWith("/blogger ") || lower === "/blogspot" || lower.startsWith("/blogspot ")) {
        const parsed = parseBlogInput(input);
        if (!parsed || !parsed.topic) {
            console.log("⚠️ Usage: @blog <topic> [--on wordpress|blogger] [--title <title>] [--no-show]");
            console.log("Example: @blog the future of local AI on wordpress");
            console.log("Example: @blogger my week in photos --title Week 12");
            return { handled: true };
        }
        try {
            const st = getBlogStatus(context ? context.settings : {});
            const apiFirst = st.source !== "browser";
            const engine = !apiFirst ? "local browser (forced)"
                : parsed.platform === "blogger" ? (st.bloggerApi ? "Blogger API" : "local browser fallback")
                : parsed.platform === "wordpress" ? (st.wordpressApi ? "WordPress API" : "local browser fallback")
                : ((st.wordpressApi || st.bloggerApi) ? "blog API" : "local browser fallback");
            const voiceChar = context && context.characterStore ? getActiveCharacter(context.characterStore) : null;
            const voicePersona = voiceChar ? composeSystemTemplate(voiceChar) : "";
            const voiceName = voiceChar ? voiceChar.name : "";
            console.log(`📝 Drafting blog post about "${parsed.topic}" (${parsed.platform}) via ${engine}${voiceName ? ` in the voice of ${voiceName}` : ""}...`);
            const res = await draftBlogViaApi(parsed.topic, context ? context.settings : {}, { platform: parsed.platform, title: parsed.title, show: parsed.show, settings: context ? context.settings : {}, ollamaClient: ollamaClient || null, characterPersona: voicePersona, characterName: voiceName });
            console.log(formatBlogDraftResult(res));
            if (res.success && context && Array.isArray(context.messages)) {
                context.messages.push({ role: "user", content: input });
                context.messages.push({ role: "assistant", content: `📝 Drafted "${res.title || parsed.topic}" on ${res.platform} (${res.url}).` });
                if (context.activeSessionId) saveSession(context.activeSessionId, context.messages);
            }
        } catch (err) {
            console.log(`⚠️ Blog draft error: ${err.message || err}`);
        }
        return { handled: true };
    }

    // Fact-check - @fact-check <claim> [--limit N] [--source auto|papers|gemini]
    // (aliases @factcheck, @fact_check, @check-fact, @verify). Semantic
    // Scholar papers + optional Gemini verdict, no browser fallback.
    {
        const parsed = parseFactCheckInput(input, context ? context.settings : {});
        if (parsed) {
            if (!parsed.claim) {
                console.log("⚠️ Usage: @fact-check <claim> [--limit N] [--source auto|papers|gemini] [--model <gemini-model>] [--no-verdict]");
                console.log("Example: @fact-check Does sleep deprivation increase risk of Alzheimer's?");
                console.log("Example: @fact-check Vaccines cause autism --source gemini");
                return { handled: true };
            }
            try {
                const st = getFactCheckStatus(context ? context.settings : {});
                const engine =
                    parsed.source === "gemini" ? "Gemini"
                    : parsed.source === "papers" ? "academic literature"
                    : st.gemini ? "academic literature + Gemini verdict" : "academic literature";
                console.log(`🔍 Fact-checking "${parsed.claim}" via ${engine}...`);
                const res = await checkFactClaimViaApi(parsed.claim, context ? context.settings : {}, { maxResults: parsed.maxResults, source: parsed.source, model: parsed.model, verdict: parsed.verdict });
                console.log(formatFactCheckResult(res));
                if (res.success && context && Array.isArray(context.messages)) {
                    context.messages.push({ role: "user", content: input });
                    context.messages.push({ role: "assistant", content: formatFactCheckResult(res) });
                    if (context.activeSessionId) saveSession(context.activeSessionId, context.messages);
                }
            } catch (err) {
                console.log(`⚠️ Fact-check error: ${err.message || err}`);
            }
            return { handled: true };
        }
    }

    // Natural blog callouts ("write a blog post about ... on @wordpress" /
    // "on @blogger", with or without a leading @character mention). Same
    // detectBlogIntent gate as the Telegram/WhatsApp bridges so the CLI
    // drafts instead of just chatting about it.
    {
        const blogIntent = detectBlogIntent(rawInput);
        if (blogIntent) {
            try {
                const mentioned = context && context.characterStore && blogIntent.mentionedCharacter
                    ? findCharacterByName(context.characterStore, blogIntent.mentionedCharacter)
                    : null;
                const voiceChar = mentioned || (context && context.characterStore ? getActiveCharacter(context.characterStore) : null);
                const voicePersona = voiceChar ? composeSystemTemplate(voiceChar) : "";
                const voiceName = voiceChar ? voiceChar.name : "";
                console.log(`📝 Drafting blog post about "${blogIntent.topic}" (${blogIntent.platform})${voiceName ? ` in the voice of ${voiceName}` : ""}...`);
                const res = await draftBlogViaApi(blogIntent.topic, context ? context.settings : {}, { platform: blogIntent.platform, show: true, settings: context ? context.settings : {}, ollamaClient: ollamaClient || null, characterPersona: voicePersona, characterName: voiceName });
                console.log(formatBlogDraftResult(res));
                if (res.success && context && Array.isArray(context.messages)) {
                    context.messages.push({ role: "user", content: input });
                    context.messages.push({ role: "assistant", content: `📝 Drafted "${res.title || blogIntent.topic}" on ${res.platform} (${res.url}).` });
                    if (context.activeSessionId) saveSession(context.activeSessionId, context.messages);
                }
            } catch (err) {
                console.log(`⚠️ Blog draft error: ${err.message || err}`);
            }
            return { handled: true };
        }
    }

    // Agentic local browser - @browser-search <query>
    if (lower.startsWith("/browser-search ")) {
        const query = input.slice("/browser-search".length).trim();
        if (!query) {
            console.log("⚠️ Usage: @browser-search <query>");
            return { handled: true };
        }
        try {
            const res = await browserSearchYoutube(query, context ? context.settings : {});
            if (res.success && res.results && res.results.length > 0) {
                console.log(`\n🌐 Top YouTube results for "${query}":`);
                res.results.forEach((r, i) => console.log(`  ${i + 1}. ${r.title}\n     ${r.url}`));
                console.log("");
            } else {
                console.log(`⚠️ No results: ${res.error || "empty result set"}`);
            }
        } catch (err) {
            console.log(`⚠️ Browser search error: ${err.message || err}`);
        }
        return { handled: true };
    }

    // Agentic local browser - @browser-search-spotify <query>
    if (lower.startsWith("/browser-search-spotify ")) {
        const query = input.slice("/browser-search-spotify".length).trim();
        if (!query) {
            console.log("⚠️ Usage: @browser-search-spotify <query>");
            return { handled: true };
        }
        try {
            const res = await browserSearchSpotify(query, context ? context.settings : {});
            if (res.success && res.results && res.results.length > 0) {
                console.log(`\n🎧 Top Spotify results for "${query}":`);
                res.results.forEach((r, i) => console.log(`  ${i + 1}. ${r.title} [${r.kind || "track"}]\n     ${r.url}`));
                console.log("");
            } else {
                console.log(`⚠️ No results: ${res.error || "empty result set"}`);
            }
        } catch (err) {
            console.log(`⚠️ Spotify search error: ${err.message || err}`);
        }
        return { handled: true };
    }

    // Agentic local browser - @browser-open <url>
    if (lower.startsWith("/browser-open ")) {
        const url = input.slice("/browser-open".length).trim();
        if (!url) {
            console.log("⚠️ Usage: @browser-open <url>");
            return { handled: true };
        }
        try {
            const res = await browserOpen(url, context ? context.settings : {});
            if (res.success) console.log(`🌐 Browser at: "${res.title || "(untitled)"}"\n🔗 ${res.url}`);
            else console.log(`⚠️ ${res.error}`);
        } catch (err) {
            console.log(`⚠️ Browser error: ${err.message || err}`);
        }
        return { handled: true };
    }

    // Agentic local browser - @browser-read
    if (lower === "/browser-read") {
        try {
            const res = await browserRead(context ? context.settings : {});
            if (res.success) {
                console.log(`\n🌐 [${res.title || res.url}]\n${res.text.slice(0, 3000)}\n`);
            } else {
                console.log(`⚠️ ${res.error}`);
            }
        } catch (err) {
            console.log(`⚠️ Browser read error: ${err.message || err}`);
        }
        return { handled: true };
    }

    // Agentic local browser - @browser-shot [name]
    if (lower === "/browser-shot" || lower.startsWith("/browser-shot ")) {
        const name = input.slice("/browser-shot".length).trim();
        try {
            const res = await browserScreenshot(name, context ? context.settings : {});
            if (res.success) console.log(`📸 Screenshot saved: ${res.path}`);
            else console.log(`⚠️ ${res.error}`);
        } catch (err) {
            console.log(`⚠️ Browser screenshot error: ${err.message || err}`);
        }
        return { handled: true };
    }

    // Agentic local browser - @browser-status
    if (lower === "/browser-status") {
        try {
            const st = await browserStatus(context ? context.settings : {});
            console.log(`\n🌐 Browser status: ${st.launched ? "running" : "stopped"} (${st.headless ? "headless fallback" : "visible window"})`);
            if (st.url) console.log(`🔗 ${st.title || ""} ${st.url}`);
            console.log(`✅ Allowed domains: ${st.allowed.join(", ")}\n`);
        } catch (err) {
            console.log(`⚠️ Browser status error: ${err.message || err}`);
        }
        return { handled: true };
    }

    // Agentic local browser - @browser-close
    if (lower === "/browser-close") {
        try {
            await browserClose();
            console.log("🌐 Local browser closed.");
        } catch (err) {
            console.log(`⚠️ Browser close error: ${err.message || err}`);
        }
        return { handled: true };
    }

    // TV cast - @cast-scan / @cast <url> / @cast-url / @cast-player /
    // @cast-pause / @cast-play / @cast-status / @cast-stop / @set-cast-device
    // (Castor-style DLNA path, Bun-only; shared parser with Telegram/WhatsApp).
    {
        const parsed = parseCastInput(input);
        if (parsed) {
            try {
                const res = await runCastCommand(input, context ? context.settings : {});
                console.log(`\n${res.reply}\n`);
                if (res.settingsChanged && context && context.settings) {
                    saveSettings(context.settings);
                }
                if (context && Array.isArray(context.messages)) {
                    context.messages.push({ role: "user", content: input });
                    context.messages.push({ role: "assistant", content: res.reply });
                    if (context.activeSessionId) saveSession(context.activeSessionId, context.messages);
                }
            } catch (err) {
                console.log(`⚠️ Cast error: ${err.message || err}`);
            }
            return { handled: true };
        }
    }

    // On-device routing / extraction via cactus-needle (https://github.com/cactus-compute/needle).
    // Single shared parser (parseNeedleInput) so CLI / Telegram / WhatsApp behave identically.
    {
        const parsed = parseNeedleInput(input, context ? context.settings : {});
        if (parsed) {
            const settings = context ? context.settings : {};
            if (parsed.action === "status") {
                try {
                    const res = await runNeedleBridge({ mode: "status" }, settings);
                    console.log(`\n${formatNeedleStatus(res, settings)}\n`);
                } catch (err) {
                    console.log(`⚠️ Needle status error: ${err.message || err}`);
                }
                return { handled: true };
            }
            if (parsed.action === "tools") {
                console.log("\n🪡 Needle on-device tool catalog:");
                for (const t of NEEDLE_DEFAULT_TOOLS) {
                    const req = (t.parameters && t.parameters.required) || [];
                    console.log(`  • ${t.name}(${req.join(", ")}) — ${t.description}`);
                }
                console.log("");
                return { handled: true };
            }
            if (parsed.action === "embed") {
                if (!parsed.text) {
                    console.log("⚠️ Usage: @needle-embed <text>");
                    return { handled: true };
                }
                try {
                    console.log(`🪡 Embedding "${parsed.text.slice(0, 80)}" on-device...`);
                    const res = await needleEmbed(parsed.text, settings);
                    if (!res || !res.success) {
                        console.log(formatNeedleExtractResult(res));
                    } else {
                        const vec = Array.isArray(res.embedding) ? res.embedding : [];
                        console.log(`🪡 Embedding dim=${res.dim || vec.length}: [${vec.slice(0, 8).map((v) => Number(v).toFixed(4)).join(", ")}${vec.length > 8 ? ", …" : ""}]`);
                    }
                } catch (err) {
                    console.log(`⚠️ Needle embed error: ${err.message || err}`);
                }
                return { handled: true };
            }
            if (parsed.action === "extract") {
                if (!parsed.schema) {
                    console.log('⚠️ Usage: @needle-extract <JSON schema> <text>');
                    console.log('Example: @needle-extract {"type":"object","properties":{"total":{"type":"number"}}} Invoice from Acme, $12.50');
                    return { handled: true };
                }
                if (!parsed.text) {
                    console.log("⚠️ Usage: @needle-extract <JSON schema> <text to extract from>");
                    return { handled: true };
                }
                try {
                    console.log("🪡 Extracting fields on-device...");
                    const res = await extractWithNeedle(parsed.text, parsed.schema, settings);
                    console.log(formatNeedleExtractResult(res));
                    if (res && res.success && !res.refused && context && Array.isArray(context.messages)) {
                        context.messages.push({ role: "user", content: input });
                        context.messages.push({ role: "assistant", content: formatNeedleExtractResult(res) });
                        if (context.activeSessionId) saveSession(context.activeSessionId, context.messages);
                    }
                } catch (err) {
                    console.log(`⚠️ Needle extract error: ${err.message || err}`);
                }
                return { handled: true };
            }
            // parsed.action === "route" (@needle <request>)
            if (!parsed.text) {
                console.log("⚠️ Usage: @needle <request>");
                console.log("Example: @needle remember that I prefer oat milk");
                console.log("Example: @needle add a task to buy milk");
                return { handled: true };
            }
            try {
                console.log("🪡 Routing on-device via Needle...");
                const res = await routeWithNeedle(parsed.text, settings, { tools: NEEDLE_DEFAULT_TOOLS });
                console.log(formatNeedleRouteResult(res, settings));
                const calls = res && res.success && Array.isArray(res.function_calls) ? res.function_calls : [];
                const conf = res && typeof res.confidence === "number" ? res.confidence : null;
                const threshold = getNeedleMinConfidence(settings);
                if (calls.length > 0 && (conf === null || conf >= threshold)) {
                    const outcomes = [];
                    for (const call of calls) {
                        outcomes.push(await executeNeedleCall(call, context));
                    }
                    for (const line of outcomes) console.log(line);
                    if (context && Array.isArray(context.messages)) {
                        context.messages.push({ role: "user", content: input });
                        context.messages.push({ role: "assistant", content: [formatNeedleRouteResult(res, settings), ...outcomes].join("\n") });
                        if (context.activeSessionId) saveSession(context.activeSessionId, context.messages);
                    }
                } else if (calls.length > 0) {
                    console.log(`🪡 Below the act threshold (${threshold}) — proposed call(s) shown above, nothing executed. Re-run with @set-setting needle_min_confidence <lower> or confirm manually.`);
                }
            } catch (err) {
                console.log(`⚠️ Needle error: ${err.message || err}`);
            }
            return { handled: true };
        }
    }

    // MCP servers — @mcp-status / @mcp-list / @mcp-tools / @mcp-call /
    // @mcp-reconnect / @mcp-enable / @mcp-disable (same parser everywhere).
    {
        const parsed = parseMcpInput(input);
        if (parsed) {
            const settings = context ? context.settings : {};
            const mgr = getMcpManager();
            try {
                if (parsed.action === "status") {
                    const st = await mgr.getStatus(settings);
                    console.log(`\n${formatMcpStatus(st)}\n`);
                } else if (parsed.action === "list") {
                    const st = await mgr.getStatus(settings);
                    console.log(`\n${formatMcpStatus(st)}\n`);
                } else if (parsed.action === "tools") {
                    if (!isMcpEnabled(settings)) {
                        console.log("🔌 MCP is disabled. Enable with @set-setting mcp_enabled on.");
                    } else {
                        console.log("🔌 Listing MCP tools (spawns enabled servers)...");
                        const tools = await mgr.listTools(settings);
                        const filtered = parsed.server
                            ? tools.filter((t) => t.function.name === parsed.server || t.function.name.startsWith(`${parsed.server}__`))
                            : tools;
                        console.log(`\n${formatMcpTools(filtered)}\n`);
                    }
                } else if (parsed.action === "call") {
                    if (!parsed.tool) {
                        console.log("⚠️ Usage: @mcp-call <server__tool> [json_args]");
                    } else {
                        let args = {};
                        if (parsed.argsJson) {
                            try { args = JSON.parse(parsed.argsJson); }
                            catch { console.log("⚠️ Second argument must be JSON. Example: @mcp-call fs__read_file {\"path\":\"/tmp/x\"}"); return { handled: true }; }
                        }
                        console.log(`🔌 Calling MCP tool ${parsed.tool}...`);
                        const out = await mgr.callTool(parsed.tool, args, settings);
                        console.log(out);
                    }
                } else if (parsed.action === "reconnect") {
                    const msgs = await mgr.reconnect(parsed.server || "", settings);
                    for (const m of msgs) console.log(`🔌 ${m}`);
                } else if (parsed.action === "enable" || parsed.action === "disable") {
                    if (!parsed.server) {
                        console.log(`⚠️ Usage: @mcp-${parsed.action} <server>`);
                    } else {
                        const { ensureMcpConfig } = await import("./mcp.js");
                        const cfg = ensureMcpConfig(settings);
                        if (!cfg.mcpServers[parsed.server]) {
                            console.log(`⚠️ MCP server "${parsed.server}" not found in ${cfg.path}.`);
                        } else {
                            if (parsed.action === "enable") delete cfg.mcpServers[parsed.server].disabled;
                            else cfg.mcpServers[parsed.server].disabled = true;
                            saveMcpConfig(cfg, cfg.path);
                            await mgr.reconnect(parsed.server, settings);
                            console.log(`🔌 MCP server "${parsed.server}" ${parsed.action}d.`);
                        }
                    }
                }
            } catch (err) {
                console.log(`⚠️ MCP error: ${err.message || err}`);
            }
            return { handled: true };
        }
    }

    return { handled: false };
}

// Backward-compatible alias: old "/"-era name still works.
export const handleSlashCommand = handleAtCommand;
