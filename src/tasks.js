import fs from "node:fs";
import path from "node:path";
import { saveSettings } from "./config.js";
import { memoize } from "./utils/memoize.js";

const TASKS_FILE = "tasks.json";

export const STATUS_MAP = {
    p: "processing",
    o: "ongoing",
    f: "finished",
    processing: "processing",
    ongoing: "ongoing",
    finished: "finished",
    "p-processing": "processing",
    "o-ongoing": "ongoing",
    "f-finished": "finished",
};

export const STATUS_SHORT_MAP = {
    processing: "p",
    ongoing: "o",
    finished: "f",
    p: "p",
    o: "o",
    f: "f",
};

export const STATUS_DISPLAY_MAP = {
    p: "Processing (p)",
    o: "Ongoing (o)",
    f: "Finished (f)",
};

function normalizeStatusUncached(statusStr) {
    if (!statusStr) return "p";
    const key = String(statusStr).trim().toLowerCase();
    return STATUS_SHORT_MAP[key] || "p";
}

export const normalizeStatus = memoize(normalizeStatusUncached, { maxSize: 200 });

export function loadTasks(filePath = TASKS_FILE) {
    if (!fs.existsSync(filePath)) {
        return [];
    }
    try {
        const raw = fs.readFileSync(filePath, "utf8");
        const data = JSON.parse(raw);
        return Array.isArray(data.tasks) ? data.tasks : [];
    } catch {
        return [];
    }
}

export function saveTasks(tasks, filePath = TASKS_FILE) {
    const payload = JSON.stringify({ tasks }, null, 2);
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, payload, "utf8");
    fs.renameSync(tmpPath, filePath);
}

/**
 * Re-indexes tasks so active tasks (processing & ongoing) are numbered 1..M,
 * followed by finished tasks (M+1..N), ensuring task numeration always
 * starts from 1 without gaps.
 */
export function reindexTasks(tasksList = null, filePath = TASKS_FILE) {
    const tasks = tasksList ?? loadTasks(filePath);
    if (!tasks || tasks.length === 0) {
        return [];
    }

    const activeTasks = tasks.filter((t) => t.status !== "f");
    const finishedTasks = tasks.filter((t) => t.status === "f");

    const reindexed = [];
    let currentId = 1;

    for (const task of activeTasks) {
        task.id = currentId++;
        reindexed.push(task);
    }
    for (const task of finishedTasks) {
        task.id = currentId++;
        reindexed.push(task);
    }

    saveTasks(reindexed, filePath);
    return reindexed;
}

export function registerTask(text, status = "p", filePath = TASKS_FILE) {
    const tasks = loadTasks(filePath);
    const normStatus = normalizeStatus(status);
    const newTask = {
        id: tasks.length + 1,
        text: text.trim(),
        status: normStatus,
        timestamp: new Date().toISOString(),
    };
    tasks.push(newTask);
    const reindexed = reindexTasks(tasks, filePath);
    return (
        reindexed.find((t) => t.timestamp === newTask.timestamp && t.text === newTask.text) || newTask
    );
}

export function getActiveTasks(filePath = TASKS_FILE) {
    const tasks = reindexTasks(null, filePath);
    return tasks.filter((t) => t.status !== "f");
}

export function getAllTasks(filePath = TASKS_FILE) {
    return reindexTasks(null, filePath);
}

export function getTaskById(taskId, filePath = TASKS_FILE) {
    const tasks = reindexTasks(null, filePath);
    const tid = parseInt(taskId, 10);
    if (isNaN(tid)) return null;
    return tasks.find((t) => t.id === tid) || null;
}

export function moveTask(taskId, newStatus, filePath = TASKS_FILE) {
    const tasks = reindexTasks(null, filePath);
    const tid = parseInt(taskId, 10);
    if (isNaN(tid)) {
        return { success: false, message: "Invalid task ID" };
    }

    const target = tasks.find((t) => t.id === tid);
    if (!target) {
        return { success: false, message: `Task #${tid} not found.` };
    }

    target.status = normalizeStatus(newStatus);
    target.updated_at = new Date().toISOString();

    const reindexed = reindexTasks(tasks, filePath);
    const updated = reindexed.find((t) => t.timestamp === target.timestamp && t.text === target.text) || target;
    return { success: true, task: updated };
}

export function deleteTask(taskId, filePath = TASKS_FILE) {
    const tasks = reindexTasks(null, filePath);
    const tid = parseInt(taskId, 10);
    if (isNaN(tid)) {
        return { success: false, message: "Invalid task ID" };
    }

    const deleted = tasks.find((t) => t.id === tid);
    if (!deleted) {
        return { success: false, message: `Task #${tid} not found.` };
    }

    const remaining = tasks.filter((t) => t.id !== tid);
    reindexTasks(remaining, filePath);
    return { success: true, task: deleted };
}

export function updateTask(taskId, { text, status }, filePath = TASKS_FILE) {
    const tasks = reindexTasks(null, filePath);
    const tid = parseInt(taskId, 10);
    if (isNaN(tid)) {
        return { success: false, message: "Invalid task ID" };
    }

    const target = tasks.find((t) => t.id === tid);
    if (!target) {
        return { success: false, message: `Task #${tid} not found.` };
    }

    if (text !== undefined) target.text = text.trim();
    if (status !== undefined) target.status = normalizeStatus(status);
    target.updated_at = new Date().toISOString();

    const reindexed = reindexTasks(tasks, filePath);
    const updated = reindexed.find((t) => t.timestamp === target.timestamp && t.text === target.text) || target;
    return { success: true, task: updated };
}

function parseMoveTaskCommandUncached(commandStr) {
    const cmd = String(commandStr).trim().replace(/^@/, "/");
    const match = cmd.match(
        /^\/move-task[-_ ]?(\d+)[-_ ]?([pof]|processing|ongoing|finished|p-processing|o-ongoing|f-finished)$/i
    );
    if (match) {
        const taskId = parseInt(match[1], 10);
        const statusCode = match[2].toLowerCase();
        return { taskId, status: normalizeStatus(statusCode) };
    }
    return null;
}

function parseDeleteTaskCommandUncached(commandStr) {
    const cmd = String(commandStr).trim().replace(/^@/, "/");
    const match = cmd.match(/^\/delete-task[-_ ]?(\d+)$/i);
    if (match) {
        return parseInt(match[1], 10);
    }
    return null;
}

export const parseMoveTaskCommand = memoize(parseMoveTaskCommandUncached, { maxSize: 500 });
export const parseDeleteTaskCommand = memoize(parseDeleteTaskCommandUncached, { maxSize: 500 });

export function formatActiveTasks(filePath = TASKS_FILE) {
    const active = getActiveTasks(filePath);
    if (active.length === 0) {
        return "📋 No unfinished tasks found.";
    }
    const lines = ["📋 Active Tasks (Unfinished):"];
    for (const t of active) {
        const label = STATUS_DISPLAY_MAP[t.status] || t.status;
        lines.push(`  • #${t.id} [${label}]: ${t.text}`);
    }
    return lines.join("\n");
}

export function formatAllTasks(filePath = TASKS_FILE) {
    const all = getAllTasks(filePath);
    if (all.length === 0) {
        return "📋 No Kanban tasks found.";
    }
    const lines = ["📋 All Kanban Tasks:"];
    for (const t of all) {
        const label = STATUS_DISPLAY_MAP[t.status] || t.status;
        lines.push(`  • #${t.id} [${label}]: ${t.text}`);
    }
    return lines.join("\n");
}

/**
 * Task Reminder Manager for background notifications.
 */
export class TaskReminderManager {
    constructor(callback, settings = null) {
        this.callback = callback;
        this.settings = settings;
        this.timer = null;
        this.intervalMinutes = settings?.task_reminder_minutes || 15;
        this.enabled = !!settings?.task_reminder_enabled;
    }

    start(minutes = 15) {
        this.stop(false);
        this.intervalMinutes = Math.max(1, minutes);
        this.enabled = true;
        if (this.settings) {
            this.settings.task_reminder_enabled = true;
            this.settings.task_reminder_minutes = this.intervalMinutes;
            saveSettings(this.settings);
        }
        this.timer = setInterval(() => {
            if (this.enabled && this.callback) {
                const activeText = formatActiveTasks();
                this.callback(activeText);
            }
        }, this.intervalMinutes * 60 * 1000);
    }

    stop(shouldSave = true) {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        this.enabled = false;
        if (shouldSave && this.settings) {
            this.settings.task_reminder_enabled = false;
            saveSettings(this.settings);
        }
    }

    getStatus() {
        return {
            enabled: this.enabled,
            intervalMinutes: this.intervalMinutes,
        };
    }
}
