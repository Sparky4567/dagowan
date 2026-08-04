import fs from "node:fs";
import path from "node:path";

const APP_SETTINGS_FILE = "app_settings.json";
const BACKUPS_DIR = "backups";

export const DEFAULT_SETTINGS = {
    model: "gpt-oss:120b-cloud",
    server_url: "http://localhost:11434",
    system_template: "You are a helpful assistant.",
    mem_limit: 10,
    active_character: "main",
    active_workspace: "default",
    whatsapp_enabled: false,
    whatsapp_phone: "",
    proactive_chat_enabled: false,
    proactive_idle_seconds: 300,
    proactive_check_seconds: 60,
    openai_api_key: "",
    gemini_api_key: "",
    claude_api_key: "",
    grok_api_key: "",
    voice_reply_enabled: false,
    task_reminder_enabled: false,
    task_reminder_minutes: 15,
    telegram_token: "",
    web_enabled: false,
    voice_server_enabled: false,
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
    if (fs.existsSync("memory.json")) {
        try {
            const raw = fs.readFileSync("memory.json", "utf8");
            const parsed = JSON.parse(raw);
            memoriesData = Array.isArray(parsed) ? parsed : (parsed.memories || []);
        } catch {}
    }

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

    const payload = {
        app: "llama-bun",
        version: "1.0",
        exported_at: new Date().toISOString(),
        app_settings: appSettings,
        memories: memoriesData,
        tasks: tasksData,
        characters: charactersData,
        sessions: sessionsData,
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
            const payload = JSON.stringify({ memories: data.memories }, null, 2);
            fs.writeFileSync("memory.json", payload, "utf8");
            summaryParts.push(`${data.memories.length} memories`);
        }

        // 3. Tasks
        if (Array.isArray(data.tasks)) {
            const payload = JSON.stringify({ tasks: data.tasks }, null, 2);
            fs.writeFileSync("tasks.json", payload, "utf8");
            summaryParts.push(`${data.tasks.length} tasks`);
        }

        // 4. Characters
        if (data.characters && typeof data.characters === "object") {
            fs.writeFileSync("characters.json", JSON.stringify(data.characters, null, 2), "utf8");
            summaryParts.push("character profiles");
        }

        // 5. Sessions
        if (data.sessions && typeof data.sessions === "object") {
            fs.writeFileSync("chat_sessions.json", JSON.stringify(data.sessions, null, 2), "utf8");
            summaryParts.push("chat sessions");
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
