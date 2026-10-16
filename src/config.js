import fs from "node:fs";
import path from "node:path";
import { getMemoryStore } from "./memory.js";
import { KnowledgeStore } from "./knowledge.js";
import { getBotDatabase } from "./db/database.js";
import { getLearningPipeline } from "./learning.js";

const APP_SETTINGS_FILE = "app_settings.json";
const BACKUPS_DIR = "backups";

export const DEFAULT_SETTINGS = {
    // Resolved at first startup to the first installed Ollama model.
    model: "",
    server_url: "http://localhost:11434",
    // Ephemeral one-shot inference via bun-ollama CLI
    // (`bun run <ollama_lite_dir>/src/index.ts run <model> --messages-json '<msgs>'`).
    // true (default): each Ollama turn loads the model, answers, then unloads
    //   it so RAM is freed immediately. 0/false/off disables this and uses
    //   the persistent HTTP daemon (model stays resident in RAM).
    ollama_ephemeral: true,
    ollama_lite_dir: "",
    ollama_ephemeral_timeout_ms: 180000,
    system_template: "You are a helpful assistant.",
    mem_limit: 10,
    active_character: "main",
    active_workspace: "default",
    whatsapp_enabled: false,
    whatsapp_phone: "",
    whatsapp_mention_only_groups: true,
    whatsapp_strip_mention: true,
    whatsapp_mention_prefix: true,
    proactive_chat_enabled: false,
    proactive_idle_seconds: 300,
    proactive_check_seconds: 60,
    openai_api_key: "",
    gemini_api_key: "",
    claude_api_key: "",
    grok_api_key: "",
    mistral_api_key: "",
    stt_engine: "local",
    tts_engine: "local",
    openai_tts_voice: "alloy",
    openai_tts_model: "tts-1",
    openai_stt_model: "whisper-1",
    voice_reply_enabled: false,
    task_reminder_enabled: false,
    task_reminder_minutes: 15,
    telegram_token: "",
    persona_polling_on_demand: true,
    persona_idle_timeout_minutes: 15,
    persona_polling_sweep_seconds: 60,
    web_enabled: false,
    voice_server_enabled: false,
    dashboard_enabled: false,
    dashboard_port: 8768,
    avatar_enabled: false,
    aifriend_enabled: false,
    aifrienddash_enabled: false,
    auto_learning_enabled: true,
    learning_model: "",
    knowledge_enabled: true,
    project_path: "projects",
    browser_enabled: true,
    browser_headless: "auto",
    browser_allowed_domains: ["youtube.com", "youtu.be", "google.com", "giphy.com", "spotify.com", "wordpress.com", "blogger.com", "blogspot.com"],
    browser_idle_close_ms: 300000,
    youtube_api_key: "",
    spotify_client_id: "",
    spotify_client_secret: "",
    play_source: "auto",
    wordpress_site_url: "",
    wordpress_username: "",
    wordpress_app_password: "",
    blogger_blog_id: "",
    blogger_api_key: "",
    blogger_access_token: "",
    blogger_client_id: "",
    blogger_client_secret: "",
    blogger_refresh_token: "",
    blogger_token_expiry: 0,
    blogger_oauth_client_file: "",
    blogger_auth_host: "",
    blog_source: "auto",
    semantic_scholar_api_key: "",
    factcheck_max_results: 3,
    factcheck_source: "auto",
    factcheck_gemini_model: "gemini-2.5-flash",
    websearch_enabled: true,
    websearch_provider: "auto",
    websearch_max_results: 5,
    websearch_timeout_ms: 12000,
    brave_api_key: "",
    tavily_api_key: "",
    needle_enabled: false,
    needle_min_confidence: 0.7,
    needle_model_path: "",
    needle_python: "",
    needle_daemon_idle_ms: 300000,
    opencli_enabled: true,
    opencli_model: "gpt-4o-mini",
    opencli_max_iterations: 12,
    opencli_allowed_chats: [],
    opencode_enabled: true,
    opencode_model: "",
    opencode_allowed_chats: [],
    opencode_auto: false,
    opencode_timeout_ms: 180000,
    opencode_bin: "",
    mcp_enabled: true,
    mcp_config_path: "mcp_servers.json",
    mcp_timeout_ms: 15000,
    security_pin_hash: "",
    security_pin_salt: "",
    security_pin_set_at: 0,
    security_unlock_minutes: 10,
    otp_secret: "",
    otp_set_at: 0,
    otp_account: "llama-chat",
    otp_issuer: "LlamaChat",
    cast_device_name: "",
    cast_device_host: "",
    cast_device_type: "auto",
    cast_port: 8901,
    cast_transcode: "auto",
    cast_max_height: 0,
    cast_scan_timeout_ms: 4000,
};

export function loadSettings(filePath = APP_SETTINGS_FILE) {
    if (!fs.existsSync(filePath)) {
        return { ...DEFAULT_SETTINGS };
    }
    try {
        const raw = fs.readFileSync(filePath, "utf8");
        const data = JSON.parse(raw);
        return { ...DEFAULT_SETTINGS, ...data };
    } catch {
        return { ...DEFAULT_SETTINGS };
    }
}

export function saveSettings(settings, filePath = APP_SETTINGS_FILE) {
    const payload = JSON.stringify(settings, null, 2);
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, payload, "utf8");
    fs.renameSync(tmpPath, filePath);
}

export function setSetting(key, value, settingsObj = null, filePath = APP_SETTINGS_FILE) {
    const settings = settingsObj || loadSettings(filePath);
    settings[key] = value;
    saveSettings(settings, filePath);
    return settings;
}

export function ensureBackupsDir(dirPath = BACKUPS_DIR) {
    const absPath = path.isAbsolute(dirPath) ? dirPath : path.join(process.cwd(), dirPath);
    if (!fs.existsSync(absPath)) {
        fs.mkdirSync(absPath, { recursive: true });
    }
    return absPath;
}

export function exportSettings(customName = null, dirPath = BACKUPS_DIR) {
    const targetDir = ensureBackupsDir(dirPath);
    let filename = "";

    if (customName) {
        filename = customName.endsWith(".json") ? customName : `${customName}.json`;
    } else {
        const dateStr = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        filename = `backup_settings_${dateStr}.json`;
    }

    const backupPath = path.join(targetDir, filename);

    // Read current data files
    const appSettings = loadSettings();

    let memoriesData = [];
    try {
        const memStore = getMemoryStore();
        memoriesData = memStore.listMemories();
    } catch {
        if (fs.existsSync("memory.json")) {
            try {
                const raw = fs.readFileSync("memory.json", "utf8");
                const parsed = JSON.parse(raw);
                memoriesData = Array.isArray(parsed) ? parsed : (parsed.memories || []);
            } catch {}
        }
    }

    let knowledgeData = [];
    try {
        const knStore = new KnowledgeStore();
        knowledgeData = knStore.listKnowledge({ status: null });
    } catch {}

    let learningLogs = [];
    try {
        const db = getBotDatabase();
        learningLogs = db.getLogs(100);
    } catch {}

    let learnedRules = [];
    try {
        const pipeline = getLearningPipeline();
        learnedRules = pipeline.listRules();
    } catch {}

    let tasksData = [];
    if (fs.existsSync("tasks.json")) {
        try {
            const raw = fs.readFileSync("tasks.json", "utf8");
            const parsed = JSON.parse(raw);
            tasksData = Array.isArray(parsed.tasks) ? parsed.tasks : [];
        } catch {}
    }

    let charactersData = null;
    if (fs.existsSync("characters.json")) {
        try {
            charactersData = JSON.parse(fs.readFileSync("characters.json", "utf8"));
        } catch {}
    }

    let sessionsData = null;
    if (fs.existsSync("chat_sessions.json")) {
        try {
            sessionsData = JSON.parse(fs.readFileSync("chat_sessions.json", "utf8"));
        } catch {}
    }

    let simulationsData = [];
    try {
        if (fs.existsSync("data/simulations")) {
            for (const f of fs.readdirSync("data/simulations")) {
                if (!f.endsWith(".json") || f.endsWith(".tmp")) continue;
                try {
                    simulationsData.push(JSON.parse(fs.readFileSync(path.join("data/simulations", f), "utf8")));
                } catch {}
            }
        }
    } catch {}

    const payload = {
        app: "llama-bun",
        version: "2.0",
        exported_at: new Date().toISOString(),
        app_settings: appSettings,
        memories: memoriesData,
        knowledge: knowledgeData,
        learning_logs: learningLogs,
        learned_rules: learnedRules,
        tasks: tasksData,
        characters: charactersData,
        sessions: sessionsData,
        simulations: simulationsData,
    };

    const tmpFile = `${backupPath}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(payload, null, 2), "utf8");
    fs.renameSync(tmpFile, backupPath);

    return backupPath;
}

export function listBackups(dirPath = BACKUPS_DIR) {
    const targetDir = ensureBackupsDir(dirPath);
    if (!fs.existsSync(targetDir)) return [];

    const files = fs.readdirSync(targetDir);
    const results = [];

    for (const file of files) {
        if (!file.endsWith(".json") || file.endsWith(".tmp")) continue;
        const filePath = path.join(targetDir, file);
        try {
            const stat = fs.statSync(filePath);
            const content = fs.readFileSync(filePath, "utf8");
            const data = JSON.parse(content);
            results.push({
                filename: file,
                path: filePath,
                modified_iso: stat.mtime.toISOString(),
                exported_at: data.exported_at || stat.mtime.toISOString(),
                memories_count: Array.isArray(data.memories) ? data.memories.length : 0,
                tasks_count: Array.isArray(data.tasks) ? data.tasks.length : 0,
                size_bytes: stat.size,
            });
        } catch {}
    }

    return results.sort((a, b) => b.modified_iso.localeCompare(a.modified_iso));
}

export function getLatestBackup(dirPath = BACKUPS_DIR) {
    const backups = listBackups(dirPath);
    return backups.length > 0 ? backups[0].path : null;
}

export function importSettings(backupFilepath, dirPath = BACKUPS_DIR) {
    let targetPath = backupFilepath;
    if (!path.isAbsolute(targetPath)) {
        targetPath = path.join(process.cwd(), targetPath);
    }

    if (!fs.existsSync(targetPath)) {
        const altPath = path.join(ensureBackupsDir(dirPath), path.basename(backupFilepath));
        if (fs.existsSync(altPath)) {
            targetPath = altPath;
        } else {
            return { success: false, message: `Backup file not found: ${backupFilepath}` };
        }
    }

    try {
        const content = fs.readFileSync(targetPath, "utf8");
        const data = JSON.parse(content);
        if (typeof data !== "object" || data === null) {
            return { success: false, message: "Invalid backup format: root must be a JSON object" };
        }

        const summaryParts = [];

        // 1. App settings
        if (data.app_settings && typeof data.app_settings === "object") {
            saveSettings(data.app_settings);
            summaryParts.push("app settings");
        }

        // 2. Memories
        if (Array.isArray(data.memories)) {
            try {
                const memStore = getMemoryStore();
                for (const m of data.memories) {
                    if (m) memStore.addMemory(m);
                }
            } catch {
                const payload = JSON.stringify({ memories: data.memories }, null, 2);
                fs.writeFileSync("memory.json", payload, "utf8");
            }
            summaryParts.push(`${data.memories.length} memories`);
        }

        // 3. Knowledge base
        if (Array.isArray(data.knowledge) && data.knowledge.length > 0) {
            try {
                const knStore = new KnowledgeStore();
                for (const k of data.knowledge) {
                    if (k && k.title && k.content) {
                        knStore.addKnowledge(k);
                    }
                }
                summaryParts.push(`${data.knowledge.length} knowledge entries`);
            } catch {}
        }

        // 4. Tasks
        if (Array.isArray(data.tasks)) {
            const payload = JSON.stringify({ tasks: data.tasks }, null, 2);
            fs.writeFileSync("tasks.json", payload, "utf8");
            summaryParts.push(`${data.tasks.length} tasks`);
        }

        // 5. Characters
        if (data.characters && typeof data.characters === "object") {
            fs.writeFileSync("characters.json", JSON.stringify(data.characters, null, 2), "utf8");
            summaryParts.push("character profiles");
        }

        // 6. Sessions
        if (data.sessions && typeof data.sessions === "object") {
            fs.writeFileSync("chat_sessions.json", JSON.stringify(data.sessions, null, 2), "utf8");
            summaryParts.push("chat sessions");
        }

        // 7. Learned Rules
        if (Array.isArray(data.learned_rules) && data.learned_rules.length > 0) {
            try {
                const pipeline = getLearningPipeline();
                for (const r of data.learned_rules) {
                    if (r && r.keywords && r.responses) {
                        pipeline.addCandidateRule(r);
                    }
                }
                summaryParts.push(`${data.learned_rules.length} learned rules`);
            } catch {}
        }

        // 8. Simulations (separate chat archives in data/simulations/)
        if (Array.isArray(data.simulations) && data.simulations.length > 0) {
            try {
                if (!fs.existsSync("data/simulations")) fs.mkdirSync("data/simulations", { recursive: true });
                let restored = 0;
                for (const s of data.simulations) {
                    if (!s || typeof s !== "object" || !s.slug) continue;
                    const safe = String(s.slug).toLowerCase().replace(/[^a-z0-9-_]+/g, "-").slice(0, 64) || "sim";
                    fs.writeFileSync(path.join("data/simulations", `${safe}.json`), JSON.stringify(s, null, 2), "utf8");
                    restored++;
                }
                if (restored > 0) summaryParts.push(`${restored} simulations`);
            } catch {}
        }

        const restoredStr = summaryParts.length > 0 ? summaryParts.join(", ") : "data";
        return {
            success: true,
            message: `Successfully restored ${restoredStr} from ${path.basename(targetPath)}.`,
            data,
        };
    } catch (err) {
        return { success: false, message: `Failed to import settings: ${err.message}` };
    }
}
