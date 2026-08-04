import fs from "node:fs";
import path from "node:path";

const MEMORY_FILE = "memory.json";

/**
 * Normalizes an item into a standard memory object: { timestamp, text }
 */
function normalizeMemoryItem(item) {
    if (typeof item === "string") {
        return {
            timestamp: new Date().toISOString(),
            text: item
        };
    }
    if (typeof item === "object" && item !== null) {
        if (item.text) {
            return {
                timestamp: item.timestamp || new Date().toISOString(),
                text: item.text
            };
        }
        if (item.content) {
            return {
                timestamp: item.timestamp || new Date().toISOString(),
                text: `[${item.role || "user"}] ${item.content}`
            };
        }
    }
    return null;
}

/**
 * Loads memories from memory.json with error handling and format migration.
 */
export function loadMemories(filePath = MEMORY_FILE) {
    if (!fs.existsSync(filePath)) {
        return [];
    }
    try {
        const raw = fs.readFileSync(filePath, "utf8");
        const data = JSON.parse(raw);
        let items = [];
        if (Array.isArray(data)) {
            items = data;
        } else if (data && Array.isArray(data.memories)) {
            items = data.memories;
        }

        return items
            .map(normalizeMemoryItem)
            .filter(Boolean);
    } catch {
        return [];
    }
}

/**
 * Saves memories atomically to memory.json.
 */
export function saveMemories(memories, filePath = MEMORY_FILE) {
    const payload = JSON.stringify({ memories }, null, 2);
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, payload, "utf8");
    fs.renameSync(tmpPath, filePath);
}

/**
 * Adds a new memory string.
 */
export function remember(text, filePath = MEMORY_FILE) {
    const memories = loadMemories(filePath);
    const newItem = {
        timestamp: new Date().toISOString(),
        text: text.trim()
    };
    memories.push(newItem);
    saveMemories(memories, filePath);
    return newItem;
}

/**
 * Deletes a memory entry by 1-based index or timestamp.
 */
export function deleteMemory(identifier, filePath = MEMORY_FILE) {
    const memories = loadMemories(filePath);
    let indexToDelete = -1;

    const num = parseInt(identifier, 10);
    if (!isNaN(num) && num >= 1 && num <= memories.length) {
        indexToDelete = num - 1;
    } else {
        indexToDelete = memories.findIndex((m) => m.timestamp === identifier);
    }

    if (indexToDelete === -1) {
        return { success: false, message: `Memory '${identifier}' not found.` };
    }

    const removed = memories.splice(indexToDelete, 1)[0];
    saveMemories(memories, filePath);
    return { success: true, removed };
}

/**
 * Updates a memory entry by 1-based index or timestamp.
 */
export function updateMemory(identifier, newText, filePath = MEMORY_FILE) {
    const memories = loadMemories(filePath);
    let target = null;

    const num = parseInt(identifier, 10);
    if (!isNaN(num) && num >= 1 && num <= memories.length) {
        target = memories[num - 1];
    } else {
        target = memories.find((m) => m.timestamp === identifier);
    }

    if (!target) {
        return { success: false, message: `Memory '${identifier}' not found.` };
    }

    target.text = newText.trim();
    target.updated_at = new Date().toISOString();
    saveMemories(memories, filePath);
    return { success: true, memory: target };
}

/**
 * Retrieves top matching memories based on word intersection scoring.
 */
export function retrieveMemories(query, limit = 10, filePath = MEMORY_FILE) {
    const memories = loadMemories(filePath);
    if (memories.length === 0) {
        return [];
    }

    if (!query || !query.trim()) {
        return memories.slice(-limit).map((m) => m.text);
    }

    const queryWords = new Set(
        query.toLowerCase().split(/\s+/).filter(Boolean)
    );

    const scored = [];
    for (const mem of memories) {
        const memWords = new Set(
            mem.text.toLowerCase().split(/\s+/).filter(Boolean)
        );
        let score = 0;
        for (const word of queryWords) {
            if (memWords.has(word)) {
                score++;
            }
        }
        if (score > 0) {
            scored.push({ score, text: mem.text, timestamp: mem.timestamp });
        }
    }

    if (scored.length > 0) {
        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, limit).map((s) => s.text);
    }

    // Fallback: If no keyword matches found, return most recent memories
    return memories.slice(-limit).map((m) => m.text);
}

/**
 * Returns formatted string listing all memories.
 */
export function formatMemories(filePath = MEMORY_FILE) {
    const memories = loadMemories(filePath);
    if (memories.length === 0) {
        return "🧠 Memory list is empty.";
    }
    const lines = ["🧠 Saved Memories:"];
    memories.forEach((m, idx) => {
        lines.push(`  ${idx + 1}. [${m.timestamp}] ${m.text}`);
    });
    return lines.join("\n");
}
