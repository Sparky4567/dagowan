import fs from "node:fs";
import path from "node:path";
import { getBotDatabase } from "./db/database.js";
import { memoize } from "./utils/memoize.js";
import {
    LANGUAGE_SHARED,
    LANGUAGE_UNKNOWN,
    detectLanguage,
    expandTokensWithBridge,
    isSharedLanguage,
    languageFileFor,
    languageFromFilePath,
    languageName,
    normalizeLanguageCode,
} from "./language.js";
import { getNeuromorphicMemory } from "./neuromorphic_memory.js";

const MEMORY_FILE = "memory.json";

const STOP_WORDS = new Set([
    "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
    "of", "with", "by", "from", "up", "about", "into", "over", "after",
    "is", "am", "are", "was", "were", "be", "been", "being", "have", "has",
    "had", "do", "does", "did", "can", "could", "shall", "should", "will",
    "would", "it", "its", "what", "which", "who", "whom", "this", "that",
    "these", "those", "tell", "show", "me", "you", "i", "we", "they"
]);

function tokenizeUncached(text) {
    if (!text || typeof text !== "string") return [];
    return text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .split(/\s+/)
        .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
}

// Pure + called per-memory per-search, so memoize it. Bounded LRU keeps
// repeated queries (same chat turn re-scored often) cheap without leaking.
export const tokenize = memoize(tokenizeUncached, { maxSize: 2000 });

// Lightweight character-trigram similarity — a dependency-free "semantic"
// signal that complements TF-IDF for paraphrases and partial matches.
function trigramSet(text) {
    const s = `  ${String(text || "").toLowerCase().replace(/[^\\p{L}\\p{N}]/gu, " ")}  `;
    const set = new Set();
    for (let i = 0; i < s.length - 2; i++) set.add(s.slice(i, i + 3));
    return set;
}

export function trigramSimilarity(a, b) {
    const A = trigramSet(a);
    const B = trigramSet(b);
    if (A.size === 0 || B.size === 0) return 0;
    let inter = 0;
    for (const t of A) if (B.has(t)) inter++;
    const union = A.size + B.size - inter;
    return union > 0 ? inter / union : 0;
}

// Maximal Marginal Relevance: keep relevance high while penalising redundancy.
export function applyMMR(items, limit = 10, lambda = 0.7) {
    if (!Array.isArray(items) || items.length === 0) return [];
    if (items.length <= limit) return items.slice();
    const remaining = items.slice();
    const selected = [remaining.shift()];
    while (selected.length < limit && remaining.length > 0) {
        let bestIdx = 0;
        let bestVal = -Infinity;
        for (let i = 0; i < remaining.length; i++) {
            const cand = remaining[i];
            const relevance = Number(cand?.activation ?? cand?.score ?? 0);
            let maxSim = 0;
            for (const sel of selected) {
                maxSim = Math.max(maxSim, trigramSimilarity(
                    cand?.memory?.content || "",
                    sel?.memory?.content || ""
                ));
            }
            const mmr = lambda * relevance - (1 - lambda) * maxSim * Math.max(relevance, 0.01);
            if (mmr > bestVal) { bestVal = mmr; bestIdx = i; }
        }
        selected.push(remaining.splice(bestIdx, 1)[0]);
    }
    return selected;
}

/**
 * Per-character memory scoping.
 *
 * Every bot persona (character) gets its own private memory pool, identified
 * by `character_id`. Rows with NULL/empty/`shared` character_id are legacy or
 * explicitly shared memories and remain visible to every character (unless a
 * caller opts out via `includeShared: false`).
 */
export const SHARED_CHARACTER_IDS = new Set(["", "shared", "global", "all"]);

export function normalizeCharacterId(id) {
    if (id === undefined || id === null) return null;
    const clean = String(id).trim();
    if (!clean) return null;
    return clean;
}

export function isSharedCharacterId(id) {
    if (id === undefined || id === null) return true;
    return SHARED_CHARACTER_IDS.has(String(id).trim().toLowerCase()) || !String(id).trim();
}

function resolveEffectiveCharacterId(...candidates) {
    for (const c of candidates) {
        const norm = normalizeCharacterId(c);
        if (norm) return norm;
    }
    return null;
}

/**
 * Builds a SQL fragment filtering memories by owner.
 * Returns { clause, params } where clause starts with " AND ..." or "".
 */
function buildCharacterClause(options = {}, paramName = "$character_id") {
    const cid = normalizeCharacterId(options.characterId ?? options.character_id ?? null);
    if (!cid) return { clause: "", params: {}, characterId: null };
    const params = { [paramName]: cid };
    if (options.includeShared === false) {
        return { clause: ` AND character_id = ${paramName}`, params, characterId: cid };
    }
    return {
        clause: ` AND (character_id = ${paramName} OR character_id IS NULL OR character_id = '' OR LOWER(character_id) = 'shared')`,
        params,
        characterId: cid,
    };
}

let isSyncingFromJson = false;

export class MemoryStore {
    constructor(db = null, syncFilePath = MEMORY_FILE, defaultCharacterId = null) {
        // Allow (db, defaultCharacterId) call shape: second string arg without
        // path-like content is treated as a character id.
        if (typeof syncFilePath === "string" && defaultCharacterId === null &&
            syncFilePath !== MEMORY_FILE && !syncFilePath.includes(".json") &&
            !syncFilePath.includes("/") && !syncFilePath.includes("\\")) {
            defaultCharacterId = syncFilePath;
            syncFilePath = MEMORY_FILE;
        } else if (syncFilePath && typeof syncFilePath === "object") {
            defaultCharacterId = syncFilePath.defaultCharacterId ?? syncFilePath.characterId ?? null;
            syncFilePath = syncFilePath.syncFilePath ?? MEMORY_FILE;
        }
        this.db = db || getBotDatabase();
        this.syncFilePath = syncFilePath;
        this.defaultCharacterId = normalizeCharacterId(defaultCharacterId);
        this.ensureCharacterColumn();
        this.ensureLanguageColumn();
        if (this.syncFilePath && this.db.filePath !== ":memory:") {
            this.syncWithJsonFile(this.syncFilePath);
        }
    }

    scopedCharacterId(explicit = null) {
        return resolveEffectiveCharacterId(explicit, this.defaultCharacterId);
    }

    ensureCharacterColumn() {
        try {
            const cols = this.db.raw.prepare("PRAGMA table_info(memories)").all() || [];
            if (!cols.some((c) => c.name === "character_id")) {
                this.db.raw.exec("ALTER TABLE memories ADD COLUMN character_id TEXT;");
            }
            this.db.raw.exec("CREATE INDEX IF NOT EXISTS idx_memories_character ON memories(character_id);");
        } catch {}
    }

    ensureLanguageColumn() {
        try {
            const cols = this.db.raw.prepare("PRAGMA table_info(memories)").all() || [];
            if (!cols.some((c) => c.name === "language")) {
                this.db.raw.exec("ALTER TABLE memories ADD COLUMN language TEXT;");
            }
            this.db.raw.exec("CREATE INDEX IF NOT EXISTS idx_memories_language ON memories(language);");
            // One-time backfill: legacy rows with NULL language get a language
            // only when detection is confident; ambiguous rows stay NULL
            // (= shared pool, visible to every language).
            try {
                const pending = this.db.query(
                    "SELECT id, content FROM memories WHERE language IS NULL OR language = ''"
                );
                if (pending.length > 0 && pending.length < 5000) {
                    for (const row of pending) {
                        try {
                            const d = detectLanguage(row.content || "");
                            if (d && d.code && d.code !== LANGUAGE_UNKNOWN && d.code !== LANGUAGE_SHARED && d.confidence >= 0.6) {
                                this.db.run("UPDATE memories SET language = $lang WHERE id = $id", {
                                    $lang: d.code,
                                    $id: row.id,
                                });
                            }
                        } catch {}
                    }
                }
            } catch {}
        } catch {}
    }

    /**
     * Initial one-way or missing migration from memory.json to DB.
     * Always global (unscoped): a scoped store must never trigger a JSON
     * import based only on its own subset being empty.
     * Also imports per-language files (memory.<lang>.json) when present.
     */
    syncWithJsonFile(filePath = this.syncFilePath) {
        if (!filePath || this.db.filePath === ":memory:") return;
        if (isSyncingFromJson) return;
        if (!fs.existsSync(filePath)) return;
        if (this.defaultCharacterId) return;

        try {
            const readItems = (fp) => {
                try {
                    if (!fs.existsSync(fp)) return [];
                    const raw = fs.readFileSync(fp, "utf8");
                    const data = JSON.parse(raw);
                    if (Array.isArray(data)) return data;
                    if (data && Array.isArray(data.memories)) return data.memories;
                    return [];
                } catch { return []; }
            };
            let items = readItems(filePath);
            // Merge per-language files (their language wins when row lacks one).
            try {
                const dir = path.dirname(path.resolve(filePath));
                const base = path.basename(filePath, ".json");
                if (fs.existsSync(dir)) {
                    for (const entry of fs.readdirSync(dir)) {
                        if (!entry.startsWith(`${base}.`) || !entry.endsWith(".json")) continue;
                        const langFromName = languageFromFilePath(entry);
                        if (!langFromName) continue;
                        for (const it of readItems(path.join(dir, entry))) {
                            if (it && typeof it === "object" && !it.language && !it.lang) {
                                it.language = langFromName;
                            }
                            items.push(it);
                        }
                    }
                }
            } catch {}

            const activeDbMemories = this.getActiveMemories();
            if (items.length > 0 && activeDbMemories.length === 0) {
                isSyncingFromJson = true;
                this.db.transaction(() => {
                    for (const item of items) {
                        const content = (typeof item === "string") ? item : (item.text || (item.content ? `[${item.role || "user"}] ${item.content}` : ""));
                        if (content && content.trim()) {
                            const id = item.id || `mem_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
                            const timestamp = item.timestamp || item.created_at || new Date().toISOString();
                            const type = item.type || "fact";
                            const confidence = typeof item.confidence === "number" ? item.confidence : 1.0;
                            const importance = typeof item.importance === "number" ? item.importance : 0.5;
                            const tags = Array.isArray(item.tags) ? item.tags : [];
                            const characterId = normalizeCharacterId(
                                (item && typeof item === "object" && (item.characterId || item.character_id)) || null
                            );
                            const language = normalizeLanguageCode(
                                (item && typeof item === "object" && (item.language || item.lang)) ||
                                detectLanguage(content).code
                            ) || LANGUAGE_UNKNOWN;
                            const langTag = languageTagFor(language);
                            if (!tags.some((t) => String(t).toLowerCase().startsWith("lang:"))) tags.push(langTag);

                            this.db.run(
                                `INSERT OR IGNORE INTO memories (
                                    id, character_id, language, type, content, source, confidence, importance, status, superseded_by,
                                    created_at, updated_at, last_used_at, usage_count, tags
                                ) VALUES ($id, $character_id, $language, $type, $content, $source, $confidence, $importance, 'active', NULL, $created_at, $updated_at, NULL, 0, $tags)`,
                                {
                                    $id: id,
                                    $character_id: characterId,
                                    $language: (language === LANGUAGE_UNKNOWN || language === LANGUAGE_SHARED) ? null : language,
                                    $type: type,
                                    $content: content.trim(),
                                    $source: item.source || "json_migration",
                                    $confidence: confidence,
                                    $importance: importance,
                                    $created_at: timestamp,
                                    $updated_at: timestamp,
                                    $tags: JSON.stringify(tags),
                                }
                            );
                        }
                    }
                });
                isSyncingFromJson = false;
            }
        } catch {}
    }

    /**
     * Synchronizes all active DB memories to memory.json (global pool with
     * per-row `language`) AND to per-language files (memory.<lang>.json).
     * Always global (unscoped) so a scoped store never overwrites the shared
     * backup file with only its own subset.
     */
    syncToJsonFile(filePath = this.syncFilePath) {
        if (!filePath || this.db.filePath === ":memory:") return;
        try {
            const rows = this.db.query("SELECT * FROM memories WHERE status = 'active' ORDER BY created_at DESC");
            const active = rows.map((r) => this.mapRow(r));
            const toEntry = (m) => ({
                id: m.id,
                characterId: m.characterId || null,
                character_id: m.characterId || null,
                language: m.language || null,
                lang: m.language || null,
                timestamp: m.createdAt,
                text: m.content,
                type: m.type,
                confidence: m.confidence,
                importance: m.importance,
                tags: m.tags,
            });
            const writeJson = (fp, list) => {
                const payload = JSON.stringify({ memories: list.map(toEntry) }, null, 2);
                const tmpPath = `${fp}.tmp`;
                fs.writeFileSync(tmpPath, payload, "utf8");
                fs.renameSync(tmpPath, fp);
            };
            writeJson(filePath, active);
            // Per-language pools: only concrete languages get their own file.
            const byLang = new Map();
            for (const m of active) {
                const norm = normalizeLanguageCode(m.language);
                if (!norm || norm === LANGUAGE_SHARED || norm === LANGUAGE_UNKNOWN) continue;
                if (!byLang.has(norm)) byLang.set(norm, []);
                byLang.get(norm).push(m);
            }
            for (const [lang, list] of byLang) {
                try { writeJson(languageFileFor(filePath, lang), list); } catch {}
            }
            // Clean up stale per-language files whose pool is now empty
            // (otherwise a deleted/emptied language keeps a ghost file).
            try {
                const dir = path.dirname(path.resolve(filePath));
                const base = path.basename(filePath, ".json");
                if (fs.existsSync(dir)) {
                    for (const entry of fs.readdirSync(dir)) {
                        if (!entry.startsWith(`${base}.`) || !entry.endsWith(".json")) continue;
                        if (entry.endsWith(".tmp")) continue;
                        const langFromName = languageFromFilePath(entry);
                        if (!langFromName || byLang.has(langFromName)) continue;
                        try { fs.unlinkSync(path.join(dir, entry)); } catch {}
                    }
                }
            } catch {}
        } catch {}
    }

    addMemory(input, characterId = null) {
        const payload = (typeof input === "string") ? { content: input } : (input || {});
        const content = (payload.content || payload.text || "").trim();
        if (!content) {
            throw new Error("Memory content cannot be empty.");
        }

        const type = payload.type || "fact";
        const confidence = typeof payload.confidence === "number" ? payload.confidence : 1.0;
        const importance = typeof payload.importance === "number" ? payload.importance : 0.5;
        const source = payload.source || "user_conversation";
        const tags = Array.isArray(payload.tags) ? payload.tags : [];
        const id = payload.id || `mem_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        const now = new Date().toISOString();
        const ownerId = resolveEffectiveCharacterId(
            characterId,
            payload.characterId,
            payload.character_id,
            this.defaultCharacterId
        );
        // Language scoping: explicit `language`/`lang` wins, otherwise detect
        // from content. NULL/ shared / und = language-neutral (visible to all).
        let language = normalizeLanguageCode(
            payload.language ?? payload.lang ?? null
        );
        let languageConfidence = typeof payload.languageConfidence === "number"
            ? payload.languageConfidence
            : (typeof payload.language_confidence === "number" ? payload.language_confidence : null);
        if (!language) {
            try {
                const det = detectLanguage(content);
                language = det.code;
                languageConfidence = det.confidence;
            } catch { language = LANGUAGE_UNKNOWN; languageConfidence = 0; }
        }
        if (!language) { language = LANGUAGE_UNKNOWN; languageConfidence = languageConfidence ?? 0; }
        const storedLanguage = (language === LANGUAGE_SHARED || language === LANGUAGE_UNKNOWN) ? null : language;
        const langTag = languageTagFor(language);
        if (!tags.some((t) => String(t).toLowerCase().startsWith("lang:"))) tags.push(langTag);

        // 1. Check for exact/near duplicate active memories (scoped to owner)
        const existing = this.findSimilarActive(content, type, ownerId);
        if (existing.exactMatch) {
            this.touchMemory(existing.exactMatch.id);
            return existing.exactMatch;
        }

        // 2. Check for contradictions or topic updates to supersede
        if (type === "correction" || (existing.conflicts && existing.conflicts.length > 0)) {
            for (const oldMem of existing.conflicts) {
                this.supersedeMemory(oldMem.id, id, `Updated by: "${content}"`);
            }
        }

        this.db.run(
            `INSERT INTO memories (
                id, character_id, language, type, content, source, confidence, importance, status, superseded_by,
                created_at, updated_at, last_used_at, usage_count, tags
            ) VALUES ($id, $character_id, $language, $type, $content, $source, $confidence, $importance, 'active', $superseded_by, $created_at, $updated_at, NULL, 0, $tags)`,
            {
                $id: id,
                $character_id: ownerId,
                $language: storedLanguage,
                $type: type,
                $content: content,
                $source: source,
                $confidence: confidence,
                $importance: importance,
                $superseded_by: payload.supersededBy || null,
                $created_at: payload.createdAt || now,
                $updated_at: payload.updatedAt || now,
                $tags: JSON.stringify(tags),
            }
        );

        this.db.logLearningEvent("memory_created", {
            id,
            characterId: ownerId,
            language: storedLanguage,
            type,
            content,
            confidence,
            source,
        });

        this.syncToJsonFile();
        return this.getMemory(id);
    }

    getMemory(id, characterId = null) {
        const row = this.db.get("SELECT * FROM memories WHERE id = $id", { $id: id });
        if (!row) return null;
        const mapped = this.mapRow(row);
        const scope = resolveEffectiveCharacterId(characterId, this.defaultCharacterId);
        if (scope && mapped.characterId && mapped.characterId !== scope) return null;
        return mapped;
    }

    listMemories(options = {}) {
        // Backwards compat: listMemories("active") or listMemories(null)
        if (typeof options === "string" || options === null || options === undefined) {
            options = options ? { status: options } : {};
        }
        let sql = "SELECT * FROM memories WHERE 1=1";
        const params = {};

        if (options.status) {
            sql += " AND status = $status";
            params.$status = options.status;
        }
        if (options.type) {
            sql += " AND type = $type";
            params.$type = options.type;
        }
        const scopeCid = resolveEffectiveCharacterId(
            options.characterId,
            options.character_id,
            this.defaultCharacterId
        );
        if (scopeCid) {
            const { clause, params: charParams } = buildCharacterClause({
                characterId: scopeCid,
                includeShared: options.includeShared,
            });
            sql += clause;
            Object.assign(params, charParams);
        } else if (options.characterId !== undefined || options.character_id !== undefined) {
            // Explicit null => unscoped (admin view of every character).
        } else if (this.defaultCharacterId) {
            const { clause, params: charParams } = buildCharacterClause({
                characterId: this.defaultCharacterId,
                includeShared: options.includeShared,
            });
            sql += clause;
            Object.assign(params, charParams);
        }
        // Language scoping: concrete code => own pool + shared/und;
        // includeOtherLanguages skips SQL filtering (retriever ranks all).
        if (options.language !== undefined || options.lang !== undefined) {
            const { clause, params: langParams } = buildLanguageClause({
                language: options.language ?? options.lang ?? null,
                includeOtherLanguages: options.includeOtherLanguages,
            });
            sql += clause;
            Object.assign(params, langParams);
        }

        sql += " ORDER BY created_at DESC";

        if (options.limit) {
            sql += ` LIMIT ${Math.floor(options.limit)}`;
        }
        if (options.offset) {
            sql += ` OFFSET ${Math.floor(options.offset)}`;
        }

        const rows = this.db.query(sql, params);
        return rows.map((r) => this.mapRow(r));
    }

    getActiveMemories(characterId = null, options = {}) {
        if (characterId && typeof characterId === "object") {
            options = characterId;
            characterId = null;
        }
        const scope = resolveEffectiveCharacterId(characterId, options.characterId, options.character_id, this.defaultCharacterId);
        return this.listMemories({
            status: "active",
            characterId: scope,
            includeShared: options.includeShared,
            language: options.language ?? options.lang ?? null,
            includeOtherLanguages: options.includeOtherLanguages,
        });
    }

    supersedeMemory(oldId, newId, reason = "superseded") {
        const now = new Date().toISOString();
        this.db.run(
            `UPDATE memories SET status = 'superseded', superseded_by = $newId, updated_at = $now WHERE id = $oldId`,
            {
                $newId: newId,
                $now: now,
                $oldId: oldId,
            }
        );

        this.db.logLearningEvent("memory_superseded", {
            oldId,
            supersededBy: newId,
            reason,
        });

        this.syncToJsonFile();
        return true;
    }

    forgetMemory(id) {
        const now = new Date().toISOString();
        this.db.run(
            `UPDATE memories SET status = 'forgotten', updated_at = $now WHERE id = $id`,
            {
                $now: now,
                $id: id,
            }
        );

        this.db.logLearningEvent("memory_forgotten", { id });
        this.syncToJsonFile();
        return true;
    }

    deleteMemory(identifier, characterId = null) {
        const scope = this.scopedCharacterId(characterId);
        const active = scope
            ? this.getActiveMemories(scope)
            : (this.defaultCharacterId ? this.getActiveMemories() : this.listMemories({ status: "active" }));
        let target = null;

        const num = parseInt(identifier, 10);
        if (!isNaN(num) && num >= 1 && num <= active.length) {
            target = active[num - 1];
        } else {
            target = active.find((m) => m.id === identifier || m.createdAt === identifier);
        }

        if (!target) {
            return { success: false, message: `Memory '${identifier}' not found.` };
        }

        this.forgetMemory(target.id);
        return { success: true, removed: { text: target.content, timestamp: target.createdAt, id: target.id } };
    }

    updateMemory(identifier, newText, characterId = null) {
        const scope = this.scopedCharacterId(characterId);
        const active = scope
            ? this.getActiveMemories(scope)
            : (this.defaultCharacterId ? this.getActiveMemories() : this.listMemories({ status: "active" }));
        let target = null;

        const num = parseInt(identifier, 10);
        if (!isNaN(num) && num >= 1 && num <= active.length) {
            target = active[num - 1];
        } else {
            target = active.find((m) => m.id === identifier || m.createdAt === identifier);
        }

        if (!target) {
            return { success: false, message: `Memory '${identifier}' not found.` };
        }

        const now = new Date().toISOString();
        let newLang = null;
        try {
            const det = detectLanguage(newText);
            newLang = det.code && det.code !== LANGUAGE_UNKNOWN && det.code !== LANGUAGE_SHARED ? det.code : null;
        } catch {}
        this.db.run(
            `UPDATE memories SET content = $content, language = $language, updated_at = $now WHERE id = $id`,
            {
                $content: newText.trim(),
                $language: newLang,
                $now: now,
                $id: target.id,
            }
        );

        this.db.logLearningEvent("memory_updated", { id: target.id, newContent: newText.trim() });
        this.syncToJsonFile();

        const updated = this.getMemory(target.id);
        return { success: true, memory: { text: updated.content, timestamp: updated.createdAt, id: updated.id } };
    }

    touchMemory(id) {
        const now = new Date().toISOString();
        this.db.run(
            `UPDATE memories SET usage_count = usage_count + 1, last_used_at = $now WHERE id = $id`,
            { $now: now, $id: id }
        );
    }

    findSimilarActive(content, type, characterId = null) {
        const scope = resolveEffectiveCharacterId(characterId, this.defaultCharacterId);
        const activeMemories = scope ? this.getActiveMemories(scope) : this.listMemories({ status: "active" });
        const cleanContent = content.toLowerCase().trim();
        const tokens = tokenize(cleanContent);

        let exactMatch = null;
        const conflicts = [];

        for (const mem of activeMemories) {
            const memClean = mem.content.toLowerCase().trim();
            if (memClean === cleanContent) {
                exactMatch = mem;
                break;
            }

            if (mem.type === type && (type === "project" || type === "preference" || type === "fact" || type === "correction" || type === "goal")) {
                const memTokens = tokenize(memClean);
                const overlap = tokens.filter((t) => memTokens.includes(t));
                const overlapRatio = overlap.length / Math.max(tokens.length, memTokens.length, 1);

                if (overlapRatio > 0.45 && memClean !== cleanContent) {
                    conflicts.push(mem);
                }
            }
        }

        return { exactMatch, conflicts };
    }

    mapRow(row) {
        let tags = [];
        try {
            tags = typeof row.tags === "string" ? JSON.parse(row.tags || "[]") : (row.tags || []);
        } catch {}

        // Language: explicit column wins; fall back to lang:* tag, then detect.
        let language = normalizeLanguageCode(row.language ?? null);
        if (!language) {
            const tagHit = (tags || []).map((t) => String(t).toLowerCase()).find((t) => t.startsWith("lang:"));
            if (tagHit) language = normalizeLanguageCode(tagHit.slice(5));
        }
        if (!language) {
            try {
                const det = detectLanguage(row.content || "");
                language = det.code === LANGUAGE_UNKNOWN ? null : det.code;
            } catch { language = null; }
        }

        return {
            id: row.id,
            characterId: row.character_id ?? null,
            character_id: row.character_id ?? null,
            language: language || null,
            lang: language || null,
            type: row.type,
            content: row.content,
            source: row.source,
            confidence: row.confidence,
            importance: row.importance,
            status: row.status,
            supersededBy: row.superseded_by,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            lastUsedAt: row.last_used_at,
            usageCount: row.usage_count,
            tags,
        };
    }

    forCharacter(characterId) {
        const cid = normalizeCharacterId(characterId);
        if (!cid) return this;
        // Construct without a sync path (skips the JSON import check), then
        // re-attach the shared path so writes still persist the GLOBAL pool.
        // syncToJsonFile/syncWithJsonFile are global, so no data loss.
        const scoped = new MemoryStore(this.db, null, cid);
        scoped.syncFilePath = this.syncFilePath || MEMORY_FILE;
        return scoped;
    }
}

export class MemoryRetriever {
    constructor(store = null, defaultCharacterId = null) {
        this.store = store || new MemoryStore();
        this.defaultCharacterId = normalizeCharacterId(defaultCharacterId);
    }

    scopedStore(characterId = null) {
        const scope = resolveEffectiveCharacterId(characterId, this.defaultCharacterId, this.store?.defaultCharacterId);
        if (!scope) return this.store;
        if (typeof this.store.forCharacter === "function") return this.store.forCharacter(scope);
        return this.store;
    }

    search(query, limit = 10, characterId = null, options = {}) {
        if (query && typeof query === "object") {
            options = query;
            query = options.query ?? "";
            limit = options.limit ?? limit;
            characterId = options.characterId ?? options.character_id ?? characterId;
        } else if (typeof limit === "object" && limit !== null) {
            options = limit;
            limit = options.limit ?? 10;
            characterId = options.characterId ?? options.character_id ?? characterId;
        } else if (typeof characterId === "object" && characterId !== null) {
            options = characterId;
            characterId = options.characterId ?? options.character_id ?? null;
        }
        const scope = resolveEffectiveCharacterId(characterId, options.characterId, options.character_id, this.defaultCharacterId, this.store?.defaultCharacterId);
        const store = scope ? (typeof this.store.forCharacter === "function" ? this.store.forCharacter(scope) : this.store) : this.store;
        const includeShared = options.includeShared;
        // Fetch the whole character pool here; language partitioning happens
        // below so the cross-lingual bridge can see other-language rows too.
        // An explicit `language` option WITHOUT cross-lingual intent can push
        // filtering down to SQL via includeOtherLanguages:false + language set
        // on getActiveMemories — but default keeps the full pool for bridging.
        const activeMemories = includeShared === undefined && !scope
            ? store.listMemories({ status: "active" })
            : store.getActiveMemories(scope ?? undefined, { includeShared });
        // Resolve active language: explicit option wins, else detect from query.
        let activeLang = normalizeLanguageCode(options.language ?? options.lang ?? null);
        let langConfidence = null;
        if (!activeLang && options.detectLanguage !== false && query && query.trim()) {
            try {
                const det = detectLanguage(query);
                if (det.code && det.code !== LANGUAGE_UNKNOWN && det.code !== LANGUAGE_SHARED) {
                    activeLang = det.code;
                    langConfidence = det.confidence;
                }
            } catch {}
        }
        const crossLingual = options.crossLingual !== false;
        const sameLangBoost = typeof options.sameLangBoost === "number" ? options.sameLangBoost : 1.25;
        const bridgePenalty = typeof options.bridgePenalty === "number" ? options.bridgePenalty : 0.45;
        const bridgeMinImportance = typeof options.bridgeMinImportance === "number" ? options.bridgeMinImportance : 0.35;
        const maxBridgeHits = typeof options.maxBridgeHits === "number"
            ? options.maxBridgeHits
            : Math.max(1, Math.ceil(limit / 2));

        const langOf = (m) => normalizeLanguageCode(m.language ?? m.lang ?? null);
        const isSharedMem = (m) => !langOf(m) || isSharedLanguage(langOf(m));
        const isSameLang = (m) => activeLang && langOf(m) === activeLang;

        let poolForPrimary = activeMemories;
        let bridgePool = [];
        if (activeLang) {
            poolForPrimary = activeMemories.filter((m) => isSameLang(m) || isSharedMem(m));
            if (crossLingual) {
                bridgePool = activeMemories.filter((m) => !isSameLang(m) && !isSharedMem(m));
            }
            // NOTE: no early fallback to the whole pool here. When the query
            // language has no memories yet, the bridge path below still gets
            // a chance to surface other-language hits (labelled); only when
            // neither primary nor bridge match anything do we fall back to
            // recent memories from the whole pool (see end of search).
        }

        if (activeMemories.length === 0 || !query || !query.trim()) {
            return poolForPrimary.slice(0, limit).map((m) => ({
                memory: m,
                score: 1.0,
                matchedTokens: [],
            }));
        }

        const queryTokens = tokenize(query);
        if (queryTokens.length === 0) {
            return poolForPrimary.slice(0, limit).map((m) => ({
                memory: m,
                score: 1.0,
                matchedTokens: [],
            }));
        }

        const scoreSet = (mems, qToks, { boost = 1, viaBridge = false } = {}) => {
            const docFreq = new Map();
            const docTokensMap = new Map();
            for (const mem of mems) {
                const docTokens = Array.from(new Set(tokenize(mem.content + " " + (mem.tags || []).join(" "))));
                docTokensMap.set(mem.id, docTokens);
                for (const t of docTokens) {
                    docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
                }
            }
            const N = Math.max(mems.length, 1);
            const out = [];
            for (const mem of mems) {
                if (viaBridge && (mem.importance ?? 0.5) < bridgeMinImportance) continue;
                const docTokens = docTokensMap.get(mem.id) || [];
                let tfIdfScore = 0;
                const matchedTokens = [];
                for (const qToken of qToks) {
                    if (docTokens.includes(qToken)) {
                        matchedTokens.push(qToken);
                        const df = docFreq.get(qToken) || 1;
                        const idf = Math.log((N + 1) / df) + 1;
                        tfIdfScore += idf;
                    }
                }
                const semanticScore = trigramSimilarity(query, mem.content + " " + (mem.tags || []).join(" "));
                if (matchedTokens.length > 0 || semanticScore >= 0.35) {
                    const importanceBoost = 1 + (mem.importance || 0.5) * 0.5;
                    const confidenceBoost = mem.confidence || 1.0;
                    const typeBoost = mem.type === "correction" ? 1.5 : (mem.type === "project" ? 1.2 : (mem.type === "preference" ? 1.1 : 1.0));
                    // Recency boost: recently used/created memories surface higher.
                    const lastTouch = mem.lastUsedAt || mem.updatedAt || mem.createdAt;
                    let recencyBoost = 1.0;
                    if (lastTouch) {
                        const ageDays = Math.max(0, (Date.now() - new Date(lastTouch).getTime()) / 86400000);
                        recencyBoost = 1 + 0.25 * Math.exp(-ageDays / 14);
                    }
                    const finalScore = (tfIdfScore * importanceBoost * confidenceBoost * typeBoost * boost * recencyBoost)
                        + 0.3 * semanticScore * (mem.importance || 0.5);
                    out.push({ memory: mem, score: finalScore, matchedTokens, viaBridge, queryLanguage: activeLang || null, semanticScore });
                }
            }
            return out;
        };

        const primary = scoreSet(poolForPrimary, queryTokens, {
            boost: activeLang ? sameLangBoost : 1,
            viaBridge: false,
        });
        let bridge = [];
        if (bridgePool.length > 0) {
            // Expand query tokens through the offline LT<->EN bridge so a
            // Lithuanian question can match an English memory and vice versa.
            const expanded = new Map(); // targetLang -> tokens
            const otherLangs = new Set(bridgePool.map((m) => langOf(m)).filter(Boolean));
            for (const other of otherLangs) {
                expanded.set(other, expandTokensWithBridge(queryTokens, activeLang, other));
            }
            const byLang = new Map();
            for (const m of bridgePool) {
                const l = langOf(m);
                if (!byLang.has(l)) byLang.set(l, []);
                byLang.get(l).push(m);
            }
            for (const [other, mems] of byLang) {
                const qToks = expanded.get(other) || queryTokens;
                // Score with both expanded and raw tokens (raw catches shared
                // code-switching / proper nouns inside other-language texts).
                const combined = Array.from(new Set([...qToks, ...queryTokens]));
                bridge.push(...scoreSet(mems, combined, { boost: bridgePenalty, viaBridge: true }));
            }
            bridge.sort((a, b) => b.score - a.score);
            bridge = bridge.slice(0, maxBridgeHits);
            for (const b of bridge) b.bridgeFrom = b.memory.language || b.memory.lang || null;
        }

        const scoredList = [...primary, ...bridge];
        if (scoredList.length > 0) {
            const neuro = getNeuromorphicMemory();
            const now = new Date().toISOString();
            const ranked = neuro.isEnabled()
                ? neuro.applyScoring(scoredList, limit, now)
                : scoredList.sort((a, b) => b.score - a.score);
            const mmrRanked = applyMMR(ranked, limit);
            // Touch spikes for the MMR-selected set (neuro scoring already
            // spiked its own top set; keep behaviour additive).
            try {
                const ids = mmrRanked.map((r) => r?.memory?.id).filter(Boolean);
                if (ids.length && neuro.isEnabled()) neuro.recordSpikes(ids, now);
            } catch {}
            return mmrRanked;
        }

        // Fallback: nothing matched in-language nor via bridge — return recent
        // memories from the SAME-language pool (+ shared), preserving language
        // isolation. For a brand-new language pool this is legitimately empty
        // (no relevant context exists yet) rather than leaking other pools.
        return poolForPrimary.slice(0, limit).map((m) => ({
            memory: m,
            score: 0.1,
            matchedTokens: [],
            queryLanguage: activeLang || null,
        }));
    }

    /**
     * Async parallel variant: DB reads stay sync on the caller, CPU scoring
     * fans out to worker_threads via parallel_retrieval.js. Falls back to
     * sync `search` math for small corpora or worker failure.
     */
    async searchParallel(query, limit = 10, characterId = null, options = {}) {
        if (query && typeof query === "object") {
            options = query;
            query = options.query ?? "";
            limit = options.limit ?? limit;
            characterId = options.characterId ?? options.character_id ?? characterId;
        } else if (typeof limit === "object" && limit !== null) {
            options = limit;
            limit = options.limit ?? 10;
            characterId = options.characterId ?? options.character_id ?? characterId;
        } else if (typeof characterId === "object" && characterId !== null) {
            options = characterId;
            characterId = options.characterId ?? options.character_id ?? null;
        }
        const scope = resolveEffectiveCharacterId(characterId, options.characterId, options.character_id, this.defaultCharacterId, this.store?.defaultCharacterId);
        const store = scope ? (typeof this.store.forCharacter === "function" ? this.store.forCharacter(scope) : this.store) : this.store;
        const includeShared = options.includeShared;
        const activeMemories = includeShared === undefined && !scope
            ? store.listMemories({ status: "active" })
            : store.getActiveMemories(scope ?? undefined, { includeShared });
        if (activeMemories.length === 0 || !query || !query.trim()) {
            return activeMemories.slice(0, limit).map((m) => ({ memory: m, score: 1.0, matchedTokens: [] }));
        }
        const queryTokens = tokenize(query);
        if (queryTokens.length === 0) {
            return activeMemories.slice(0, limit).map((m) => ({ memory: m, score: 1.0, matchedTokens: [] }));
        }
        // Language-aware scoring (same-language boost + translation bridge)
        // lives in sync `search`; the worker path below is TF-IDF-only, so
        // delegate whenever language scoping/bridging is in play.
        const needsLanguagePath = options.language !== undefined || options.lang !== undefined ||
            options.crossLingual !== undefined || options.detectLanguage !== false;
        if (!needsLanguagePath) {
            try {
                const { searchMemoriesScored } = await import("./utils/parallel_retrieval.js");
                const scored = await searchMemoriesScored(activeMemories, queryTokens, options.workerOptions || {});
                if (scored.length > 0) {
                    scored.sort((a, b) => b.score - a.score);
                    const mmrRanked = applyMMR(scored, limit);
                    return mmrRanked;
                }
            } catch {}
        }
        return this.search(query, limit, characterId, options);
    }
}

let defaultMemoryStoreInstance = null;
const scopedMemoryStoreInstances = new Map();

export function getMemoryStore(characterId = null) {
    const cid = normalizeCharacterId(characterId);
    if (!cid) {
        if (!defaultMemoryStoreInstance) {
            defaultMemoryStoreInstance = new MemoryStore();
        }
        return defaultMemoryStoreInstance;
    }
    if (!scopedMemoryStoreInstances.has(cid)) {
        const base = getMemoryStore(null);
        scopedMemoryStoreInstances.set(cid, base.forCharacter(cid));
    }
    return scopedMemoryStoreInstances.get(cid);
}

export function getMemoryStoreForCharacter(characterId) {
    return getMemoryStore(characterId);
}

export function resolveMemoryCharacterId(...candidates) {
    return resolveEffectiveCharacterId(...candidates);
}

export function resolveMemoryLanguage(...candidates) {
    for (const c of candidates) {
        const norm = normalizeLanguageCode(c);
        if (norm) return norm;
    }
    return null;
}

/**
 * Builds a SQL fragment filtering memories by language.
 * - null/undefined => no filtering (whole pool).
 * - "shared" => only shared/undetermined memories.
 * - concrete code (e.g. "lt") => that language + shared/undetermined.
 *   Pass `includeOtherLanguages: true` to skip filtering entirely and let
 *   the retriever rank the whole pool (used for cross-lingual bridge).
 */
function buildLanguageClause(options = {}, paramName = "$language") {
    const raw = options.language ?? options.lang ?? null;
    const norm = normalizeLanguageCode(raw);
    if (!norm) return { clause: "", params: {}, language: null };
    if (norm === LANGUAGE_SHARED || norm === LANGUAGE_UNKNOWN) {
        return {
            clause: ` AND (language IS NULL OR language = '' OR LOWER(language) IN ('shared', 'und', 'unknown'))`,
            params: {},
            language: norm,
        };
    }
    if (options.includeOtherLanguages === true) return { clause: "", params: {}, language: norm };
    return {
        clause: ` AND (language = ${paramName} OR language IS NULL OR language = '' OR LOWER(language) IN ('shared', 'und', 'unknown'))`,
        params: { [paramName]: norm },
        language: norm,
    };
}

export function languageTagFor(code) {
    const norm = normalizeLanguageCode(code);
    if (!norm || norm === LANGUAGE_SHARED || norm === LANGUAGE_UNKNOWN) return "lang:shared";
    return `lang:${norm}`;
}

function parseFilePathAndCharacterId(filePath, characterId) {
    // Supports legacy (filePath) and new (characterId / options) call shapes.
    let resolvedFile = MEMORY_FILE;
    let resolvedChar = null;
    let includeShared;
    if (filePath && typeof filePath === "object") {
        resolvedChar = filePath.characterId ?? filePath.character_id ?? characterId ?? null;
        resolvedFile = filePath.filePath ?? filePath.syncFilePath ?? MEMORY_FILE;
        includeShared = filePath.includeShared;
    } else if (typeof filePath === "string") {
        const looksLikePath = filePath.includes(".json") || filePath.includes("/") || filePath.includes("\\") || filePath === MEMORY_FILE;
        if (looksLikePath) {
            resolvedFile = filePath;
            resolvedChar = normalizeCharacterId(characterId);
        } else {
            resolvedChar = normalizeCharacterId(filePath) || normalizeCharacterId(characterId);
        }
    } else if (filePath === null || filePath === undefined) {
        resolvedChar = normalizeCharacterId(characterId);
    }
    return { filePath: resolvedFile, characterId: resolvedChar, includeShared };
}

// -------------------------------------------------------------
// Backwards Compatibility Functions (now character-aware)
// -------------------------------------------------------------

function ownerLabel(m) {
    const cid = m.characterId || m.character_id || null;
    return cid || "shared";
}

function langLabel(m) {
    const l = normalizeLanguageCode(m.language ?? m.lang ?? null);
    return l || "shared";
}

export function loadMemories(filePath = MEMORY_FILE, characterId = null) {
    let resolvedChar = characterId;
    let resolvedInclude;
    let resolvedLang;
    if (filePath && typeof filePath === "object") {
        resolvedChar = filePath.characterId ?? filePath.character_id ?? characterId;
        resolvedInclude = filePath.includeShared;
        resolvedLang = filePath.language ?? filePath.lang ?? null;
    }
    const store = getMemoryStore(resolvedChar);
    const list = resolvedChar
        ? store.getActiveMemories({ includeShared: resolvedInclude, language: resolvedLang })
        : store.listMemories({ status: "active", language: resolvedLang });
    return list.map((m) => ({
        id: m.id,
        characterId: m.characterId || null,
        character_id: m.characterId || null,
        language: m.language || null,
        lang: m.language || null,
        timestamp: m.createdAt,
        text: m.content,
        type: m.type,
        confidence: m.confidence,
        importance: m.importance,
        tags: m.tags,
    }));
}

export function saveMemories(memories, filePath = MEMORY_FILE, characterId = null) {
    const parsed = parseFilePathAndCharacterId(filePath, characterId);
    const store = getMemoryStore(parsed.characterId);
    if (Array.isArray(memories)) {
        for (const item of memories) {
            const content = typeof item === "string" ? item : (item.text || item.content);
            if (content) {
                store.addMemory(item);
            }
        }
    }
    store.syncToJsonFile(parsed.filePath);
}

export function remember(textOrPayload, filePath = MEMORY_FILE, characterId = null) {
    const parsed = parseFilePathAndCharacterId(filePath, characterId);
    const store = getMemoryStore(parsed.characterId);
    const payloadIsObj = textOrPayload && typeof textOrPayload === "object";
    const payloadChar = payloadIsObj ? (textOrPayload.characterId || textOrPayload.character_id) : null;
    const mem = store.addMemory(textOrPayload, payloadChar || parsed.characterId);
    return {
        id: mem.id,
        characterId: mem.characterId || null,
        language: mem.language || null,
        lang: mem.language || null,
        timestamp: mem.createdAt,
        text: mem.content,
        type: mem.type,
        confidence: mem.confidence,
    };
}

export function deleteMemory(identifier, filePath = MEMORY_FILE, characterId = null) {
    const parsed = parseFilePathAndCharacterId(filePath, characterId);
    const store = getMemoryStore(parsed.characterId);
    return store.deleteMemory(identifier, parsed.characterId);
}

export function forgetMemory(identifier, characterId = null) {
    const store = getMemoryStore(characterId);
    return store.forgetMemory(identifier);
}

export function updateMemory(identifier, newText, filePath = MEMORY_FILE, characterId = null) {
    // Allow updateMemory(id, text, characterId) without a file path.
    let parsed;
    if (typeof filePath === "string" && characterId === null &&
        !filePath.includes(".json") && !filePath.includes("/") && newText !== undefined) {
        parsed = { filePath: MEMORY_FILE, characterId: normalizeCharacterId(filePath), includeShared: undefined };
    } else {
        parsed = parseFilePathAndCharacterId(filePath, characterId);
    }
    const store = getMemoryStore(parsed.characterId);
    return store.updateMemory(identifier, newText, parsed.characterId);
}

export function supersedeMemory(oldId, newId, reason) {
    const store = getMemoryStore();
    return store.supersedeMemory(oldId, newId, reason);
}

export function retrieveMemories(query, limit = 10, filePath = MEMORY_FILE, characterId = null) {
    let resolvedLimit = limit;
    let resolvedChar = characterId;
    let resolvedInclude;
    let resolvedFile = MEMORY_FILE;
    let resolvedLang;
    let resolvedOpts = {};
    if (limit && typeof limit === "object") {
        resolvedLimit = limit.limit ?? 10;
        resolvedChar = limit.characterId ?? limit.character_id ?? characterId;
        resolvedInclude = limit.includeShared;
        resolvedFile = limit.filePath ?? MEMORY_FILE;
        resolvedLang = limit.language ?? limit.lang ?? null;
        resolvedOpts = limit;
    } else if (filePath && typeof filePath === "object") {
        resolvedChar = filePath.characterId ?? filePath.character_id ?? characterId;
        resolvedInclude = filePath.includeShared;
        resolvedFile = filePath.filePath ?? MEMORY_FILE;
        resolvedLang = filePath.language ?? filePath.lang ?? null;
        resolvedOpts = filePath;
    } else {
        const parsed = parseFilePathAndCharacterId(filePath, characterId);
        resolvedChar = parsed.characterId;
        resolvedFile = parsed.filePath;
        resolvedInclude = parsed.includeShared;
    }
    void resolvedFile;
    const retriever = new MemoryRetriever(getMemoryStore(resolvedChar));
    const results = retriever.search(query, resolvedLimit, resolvedChar, {
        includeShared: resolvedInclude,
        language: resolvedLang,
        crossLingual: resolvedOpts.crossLingual,
        detectLanguage: resolvedOpts.detectLanguage,
        maxBridgeHits: resolvedOpts.maxBridgeHits,
    });
    return results.map((r) => {
        const memLang = (r.memory?.language || r.memory?.lang || "").toLowerCase();
        if (r.viaBridge && memLang) return `${r.memory.content} [via ${memLang} memory — translated association]`;
        return r.memory.content;
    });
}

export function retrieveDetailedMemories(query, limit = 10, characterId = null, options = {}) {
    if (limit && typeof limit === "object") {
        options = limit;
        limit = options.limit ?? 10;
        characterId = options.characterId ?? options.character_id ?? characterId;
    } else if (characterId && typeof characterId === "object") {
        options = characterId;
        characterId = options.characterId ?? options.character_id ?? null;
    }
    const retriever = new MemoryRetriever(getMemoryStore(characterId));
    return retriever.search(query, limit, characterId, options);
}

/** Async parallel variant (worker-thread scoring, sync fallback). */
export async function retrieveMemoriesParallel(query, limit = 10, characterId = null, options = {}) {
    if (limit && typeof limit === "object") {
        options = limit;
        limit = options.limit ?? 10;
        characterId = options.characterId ?? options.character_id ?? characterId;
    } else if (characterId && typeof characterId === "object") {
        options = characterId;
        characterId = options.characterId ?? options.character_id ?? null;
    }
    const retriever = new MemoryRetriever(getMemoryStore(characterId));
    const results = await retriever.searchParallel(query, limit, characterId, options);
    return results.map((r) => r.memory.content);
}

export function formatMemories(query = null, limit = 15, options = {}, characterId = null) {
    if (typeof options === "string") {
        characterId = options;
        options = {};
    }
    const scope = resolveEffectiveCharacterId(characterId, options.characterId, options.character_id);
    const langOpt = normalizeLanguageCode(options.language ?? options.lang ?? null);
    const store = getMemoryStore(scope);
    const retriever = new MemoryRetriever(store);
    const scopeSuffix = scope ? ` for "${scope}"` : "";
    const langSuffix = langOpt ? ` [lang:${langOpt}]` : "";
    const baseFilter = {
        status: "active",
        characterId: scope,
        includeShared: options.includeShared,
        language: langOpt || undefined,
    };
    if (query && query.trim()) {
        const results = retriever.search(query, limit, scope, {
            includeShared: options.includeShared,
            language: langOpt || undefined,
            crossLingual: options.crossLingual,
            maxBridgeHits: options.maxBridgeHits,
        });
        if (results.length === 0) {
            return `🧠 No memories found matching "${query}"${scopeSuffix}${langSuffix}.`;
        }
        const lines = [`🧠 Memory Search Results for "${query}"${scopeSuffix}${langSuffix} (${results.length}):`];
        results.forEach((r, idx) => {
            const bridge = r.viaBridge ? ` [bridge from ${r.bridgeFrom || r.memory.language || "?"}]` : "";
            lines.push(`  ${idx + 1}. [${r.memory.id}] [${ownerLabel(r.memory)}] [${langLabel(r.memory)}] (${r.memory.type})${bridge} Score: ${r.score.toFixed(2)} (Conf: ${r.memory.confidence})`);
            lines.push(`     ${r.memory.content}`);
        });
        return lines.join("\n");
    }

    if (options.all === true) {
        const all = store.listMemories({ ...baseFilter });
        if (all.length === 0) {
            return `🧠 Memory list is empty${scopeSuffix}${langSuffix}.`;
        }
        const lines = [`🧠 Saved Persistent Memories${scopeSuffix}${langSuffix} (${all.length}):`];
        all.forEach((m, idx) => {
            const statusTag = m.status === "superseded" ? ` [SUPERSEDED by ${m.supersededBy || "?"}]` : (m.status === "forgotten" ? " [FORGOTTEN]" : "");
            lines.push(`  ${idx + 1}. [${m.id}] [${ownerLabel(m)}] [${langLabel(m)}] (${m.type})${statusTag} (Conf: ${Number(m.confidence || 0).toFixed(2)})`);
            lines.push(`     ${m.content}`);
        });
        return lines.join("\n");
    }

    const total = store.listMemories({ ...baseFilter }).length;
    const page = store.listMemories({ ...baseFilter, limit });
    if (page.length === 0) {
        return `🧠 Memory list is empty${scopeSuffix}${langSuffix}.`;
    }
    const lines = [`🧠 Saved Persistent Memories${scopeSuffix}${langSuffix} (showing ${page.length} of ${total}, use @memories-all for full list):`];
    page.forEach((m, idx) => {
        const statusTag = m.status === "superseded" ? ` [SUPERSEDED by ${m.supersededBy || "?"}]` : (m.status === "forgotten" ? " [FORGOTTEN]" : "");
        lines.push(`  ${idx + 1}. [${m.id}] [${ownerLabel(m)}] [${langLabel(m)}] (${m.type})${statusTag} (Conf: ${Number(m.confidence || 0).toFixed(2)})`);
        lines.push(`     ${m.content}`);
    });
    return lines.join("\n");
}

/** Per-language (+shared) memory counts for @stats / @memory-langs. */
export function getMemoryLanguageStats(characterId = null) {
    const store = getMemoryStore(characterId);
    const rows = store.listMemories({ status: "active", characterId: characterId || undefined });
    const counts = {};
    for (const m of rows) {
        const l = langLabel(m);
        counts[l] = (counts[l] || 0) + 1;
    }
    return Object.entries(counts)
        .map(([lang, count]) => ({ language: lang, name: languageName(lang), count }))
        .sort((a, b) => b.count - a.count);
}

export function formatMemoryLanguageStats(characterId = null) {
    const stats = getMemoryLanguageStats(characterId);
    if (stats.length === 0) return "🧠 No active memories yet (all language pools empty).";
    const lines = [`🧠 Memories by Language${characterId ? ` for "${characterId}"` : ""} (total ${stats.reduce((n, s) => n + s.count, 0)}):`];
    for (const s of stats) lines.push(`  • ${s.language} (${s.name}): ${s.count}`);
    lines.push("  (Each turn uses its own language pool + shared; other languages join via bridge.)");
    return lines.join("\n");
}
