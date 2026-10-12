/**
 * Parallel chat-context assembly.
 *
 * DB/file reads stay on the main thread; CPU-bound scoring fans out to
 * worker_threads (see src/utils/parallel_retrieval.js), and the three
 * independent sources (memories / knowledge / past sessions) resolve
 * concurrently via Promise.all instead of sequentially.
 */
import { getMemoryStore } from "./memory.js";
import { KnowledgeStore, tokenize as knowledgeTokenize } from "./knowledge.js";
import { scoreSessionMessagesScored } from "./utils/parallel_retrieval.js";
import { searchKnowledgeScored } from "./utils/parallel_retrieval.js";
import { detectLanguage, normalizeLanguageCode } from "./language.js";
import fs from "node:fs";

const SESSIONS_FILE = "chat_sessions.json";

function readSessions(filePath = SESSIONS_FILE) {
    if (!fs.existsSync(filePath)) return { sessions: [] };
    try {
        const raw = fs.readFileSync(filePath, "utf8");
        const data = JSON.parse(raw);
        if (data && Array.isArray(data.sessions)) return data;
    } catch {}
    return { sessions: [] };
}

/**
 * Retrieve memories + knowledge + session context in parallel.
 * Falls back to sync scoring per-source on worker failure.
 */
export async function retrieveChatContextParallel(queryText, {
    characterId = null,
    excludeSessionId = null,
    memoryLimit = 5,
    knowledgeLimit = 4,
    sessionLimit = 3,
    sessionsFile = SESSIONS_FILE,
    workerOptions = {},
    simulationLimit = 3,
    includeSimulations = true,
    excludeSimulationSlug = null,
    language = null,
    crossLingual = true,
} = {}) {
    const q = queryText || "";
    // Active turn language drives memory scoping (explicit option wins,
    // otherwise auto-detect from the query).
    let activeLang = normalizeLanguageCode(language);
    if (!activeLang && q.trim()) {
        try {
            const det = detectLanguage(q);
            if (det.code && det.code !== "und" && det.code !== "shared") activeLang = det.code;
        } catch {}
    }
    const [memories, knowledge, pastContext, simulations] = await Promise.all([
        (async () => {
            try {
                const { MemoryRetriever } = await import("./memory.js");
                const store = getMemoryStore(characterId);
                const retriever = new MemoryRetriever(store);
                const scope = characterId ? String(characterId).trim() || null : null;
                const results = retriever.search(q, memoryLimit, scope || null, {
                    language: activeLang || undefined,
                    crossLingual,
                });
                // Backwards-compatible strings with bridge provenance inline,
                // so prompts show which hits came through translation.
                return results.map((r) => {
                    const memLang = normalizeLanguageCode(r.memory?.language ?? r.memory?.lang ?? null);
                    if (r.viaBridge && memLang && activeLang && memLang !== activeLang) {
                        return `${r.memory.content} [via ${memLang} memory — translated association]`;
                    }
                    return r.memory.content;
                });
            } catch {
                const { retrieveMemories } = await import("./memory.js");
                return retrieveMemories(q, memoryLimit, undefined, characterId);
            }
        })(),
        (async () => {
            try {
                const store = new KnowledgeStore();
                const all = store.listKnowledge({ status: "active" });
                if (all.length === 0 || !q.trim()) return [];
                const queryTokens = knowledgeTokenize(q);
                if (queryTokens.length === 0) return [];
                const scored = await searchKnowledgeScored(all, queryTokens, q.toLowerCase().trim(), workerOptions);
                scored.sort((a, b) => b.score - a.score);
                return scored.slice(0, knowledgeLimit);
            } catch {
                const { retrieveKnowledge } = await import("./knowledge.js");
                return retrieveKnowledge(q, knowledgeLimit);
            }
        })(),
        (async () => {
            try {
                if (!q.trim()) return [];
                const queryWords = Array.from(new Set(q.toLowerCase().match(/\w+/g) || []));
                if (queryWords.length === 0) return [];
                const store = readSessions(sessionsFile);
                const scope = characterId ? String(characterId).trim() || null : null;
                const flat = [];
                for (const session of store.sessions) {
                    if (excludeSessionId && session.id === excludeSessionId) continue;
                    if (scope && session.character_id !== scope && !(session.participant_character_ids?.includes(scope))) continue;
                    for (const msg of session.messages || []) {
                        if (msg.role !== "user" && msg.role !== "assistant") continue;
                        flat.push({
                            session_title: session.title || "Previous conversation",
                            character_id: session.character_id || null,
                            role: msg.role,
                            content: String(msg.content || "").trim(),
                            updated_at: session.updated_at || "",
                        });
                    }
                }
                const scored = await scoreSessionMessagesScored(flat, queryWords, workerOptions);
                scored.sort((a, b) => b.score - a.score || String(b.updated_at).localeCompare(String(a.updated_at)));
                return scored.slice(0, sessionLimit).map(({ session_title, character_id, role, content }) => ({
                    session_title, character_id, role, content,
                }));
            } catch {
                const { retrieveSessionContext } = await import("./sessions.js");
                return retrieveSessionContext(q, excludeSessionId, sessionLimit, characterId, sessionsFile);
            }
        })(),
        (async () => {
            // Simulation archive association recall (only genuine token matches).
            if (!includeSimulations) return [];
            try {
                if (!q.trim()) return [];
                const { searchSimulationArchives } = await import("./simulation.js");
                return searchSimulationArchives(q, { characterId, excludeSlug: excludeSimulationSlug, limit: simulationLimit });
            } catch {
                return [];
            }
        })(),
    ]);
    const bridgeHits = (memories || []).filter((m) => typeof m === "string" && m.includes("[via ")).length;
    return { memories, knowledge, pastContext, simulations, language: activeLang, bridgeHits };
}
