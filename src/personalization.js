import { getMemoryStore } from "./memory.js";

const PROFILE_TYPES = ["preference", "instruction", "correction", "goal", "project"];

/**
 * Build a compact, stable "user profile" block from durable memories so the
 * model personalises tone/content without re-deriving it every turn.
 */
export function buildUserProfileBlock(characterId = null, { maxItems = 12 } = {}) {
    let store;
    try {
        store = getMemoryStore(characterId);
    } catch {
        return "";
    }
    const lines = [];
    const seen = new Set();
    for (const type of PROFILE_TYPES) {
        let items = [];
        try {
            items = store.listMemories({ status: "active", type });
        } catch {
            items = [];
        }
        for (const m of items) {
            const content = String(m.content || "").trim();
            if (!content) continue;
            const key = content.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            lines.push(`- [${type}] ${content}`);
            if (lines.length >= maxItems) break;
        }
        if (lines.length >= maxItems) break;
    }
    if (lines.length === 0) return "";
    return `[User Profile (durable preferences & instructions)]:\n${lines.join("\n")}`;
}