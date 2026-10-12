import { getBotDatabase } from "./db/database.js";
import { memoize } from "./utils/memoize.js";

const STOP_WORDS = new Set([
    "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
    "of", "with", "by", "from", "up", "about", "into", "over", "after",
    "is", "am", "are", "was", "were", "be", "been", "being", "have", "has",
    "had", "do", "does", "did", "can", "could", "shall", "should", "will",
    "would", "it", "its", "what", "which", "who", "whom", "this", "that",
    "these", "those"
]);

function tokenizeUncached(text) {
    if (!text || typeof text !== "string") return [];
    return text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .split(/\s+/)
        .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
}

// Same tokenizer shape as memory.js; memoized separately to keep each
// module dependency-free of the other.
export const tokenize = memoize(tokenizeUncached, { maxSize: 2000 });

export class KnowledgeStore {
    constructor(db = null) {
        this.db = db || getBotDatabase();
    }

    addKnowledge({
        title,
        content,
        category = "concept",
        sourceType = "user",
        sourceRef = null,
        confidence = 1.0,
        changeReason = "Initial creation",
    }) {
        if (!title || !content) {
            throw new Error("Title and content are required for knowledge entries.");
        }

        const existing = this.findByExactTitle(title);
        if (existing) {
            return this.updateKnowledge(existing.id, {
                content,
                category,
                sourceType,
                sourceRef,
                confidence,
                changeReason: changeReason || "Updated with new information",
            });
        }

        const id = `kn_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        const now = new Date().toISOString();

        this.db.run(
            `INSERT INTO knowledge (
                id, title, content, category, source_type, source_ref, confidence,
                version, previous_version_id, change_reason, status, created_at, updated_at
            ) VALUES ($id, $title, $content, $category, $source_type, $source_ref, $confidence,
                1, NULL, $change_reason, 'active', $created_at, $updated_at)`,
            {
                $id: id,
                $title: title.trim(),
                $content: content.trim(),
                $category: category,
                $source_type: sourceType,
                $source_ref: sourceRef || null,
                $confidence: Number(confidence) || 1.0,
                $change_reason: changeReason || "Initial creation",
                $created_at: now,
                $updated_at: now,
            }
        );

        this.db.logLearningEvent("knowledge_created", {
            id,
            title: title.trim(),
            category,
            sourceType,
        });

        return this.getKnowledge(id);
    }

    updateKnowledge(currentId, {
        title,
        content,
        category,
        sourceType,
        sourceRef,
        confidence,
        changeReason = "Updated with new information",
    }) {
        const current = this.getKnowledge(currentId);
        if (!current) {
            throw new Error(`Knowledge item ${currentId} not found`);
        }

        const newId = `kn_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        const now = new Date().toISOString();
        const newVersion = (current.version || 1) + 1;
        const newTitle = title ? title.trim() : current.title;
        const newCategory = category || current.category;
        const newSourceType = sourceType || current.sourceType;
        const newSourceRef = sourceRef !== undefined ? sourceRef : current.sourceRef;
        const newConfidence = confidence !== undefined ? Number(confidence) : current.confidence;

        // Deprecate previous version
        this.db.run(
            `UPDATE knowledge SET status = 'deprecated', updated_at = $now WHERE id = $currentId`,
            { $now: now, $currentId: currentId }
        );

        // Insert new version
        this.db.run(
            `INSERT INTO knowledge (
                id, title, content, category, source_type, source_ref, confidence,
                version, previous_version_id, change_reason, status, created_at, updated_at
            ) VALUES ($id, $title, $content, $category, $source_type, $source_ref, $confidence,
                $version, $previous_version_id, $change_reason, 'active', $created_at, $updated_at)`,
            {
                $id: newId,
                $title: newTitle,
                $content: content.trim(),
                $category: newCategory,
                $source_type: newSourceType,
                $source_ref: newSourceRef || null,
                $confidence: newConfidence,
                $version: newVersion,
                $previous_version_id: currentId,
                $change_reason: changeReason,
                $created_at: now,
                $updated_at: now,
            }
        );

        this.db.logLearningEvent("knowledge_version_updated", {
            previousId: currentId,
            newId,
            title: newTitle,
            version: newVersion,
            reason: changeReason,
        });

        return this.getKnowledge(newId);
    }

    getKnowledge(id) {
        const row = this.db.get("SELECT * FROM knowledge WHERE id = $id", { $id: id });
        if (!row) return null;
        return this.mapRow(row);
    }

    findByExactTitle(title) {
        if (!title) return null;
        const row = this.db.get(
            "SELECT * FROM knowledge WHERE LOWER(title) = LOWER($title) AND status = 'active'",
            { $title: title.trim() }
        );
        if (!row) return null;
        return this.mapRow(row);
    }

    listKnowledge({ status = "active", category = null, limit = null } = {}) {
        let sql = "SELECT * FROM knowledge WHERE 1=1";
        const params = {};

        if (status) {
            sql += " AND status = $status";
            params.$status = status;
        }
        if (category) {
            sql += " AND category = $category";
            params.$category = category;
        }

        sql += " ORDER BY updated_at DESC";

        if (limit) {
            sql += ` LIMIT ${Math.floor(limit)}`;
        }

        const rows = this.db.query(sql, params);
        return rows.map((r) => this.mapRow(r));
    }

    deleteKnowledge(id) {
        const now = new Date().toISOString();
        this.db.run(
            `UPDATE knowledge SET status = 'deprecated', updated_at = $now WHERE id = $id`,
            { $id: id, $now: now }
        );
        this.db.logLearningEvent("knowledge_deleted", { id });
        return true;
    }

    getVersionHistory(id) {
        const history = [];
        let currentId = id;

        while (currentId) {
            const entry = this.getKnowledge(currentId);
            if (!entry) break;
            history.push(entry);
            currentId = entry.previousVersionId || null;
        }

        return history;
    }

    mapRow(row) {
        return {
            id: row.id,
            title: row.title,
            content: row.content,
            category: row.category,
            sourceType: row.source_type,
            sourceRef: row.source_ref,
            confidence: row.confidence,
            version: row.version,
            previousVersionId: row.previous_version_id,
            changeReason: row.change_reason,
            status: row.status,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        };
    }
}

export class KnowledgeRetriever {
    constructor(store = null) {
        this.store = store || new KnowledgeStore();
    }

    search(query, limit = 4, category = null) {
        const allKnowledge = this.store.listKnowledge({ status: "active", category });
        if (allKnowledge.length === 0 || !query || !query.trim()) {
            return [];
        }

        const queryTokens = tokenize(query);
        if (queryTokens.length === 0) return [];

        const scoredList = [];
        const cleanQuery = query.toLowerCase().trim();

        for (const item of allKnowledge) {
            const titleTokens = tokenize(item.title);
            const contentTokens = tokenize(item.content);

            let score = 0;
            const matchedTokens = [];

            for (const qToken of queryTokens) {
                if (titleTokens.includes(qToken)) {
                    score += 5;
                    matchedTokens.push(qToken);
                } else if (contentTokens.includes(qToken)) {
                    score += 1.5;
                    matchedTokens.push(qToken);
                }
            }

            if (item.title.toLowerCase().includes(cleanQuery)) {
                score += 10;
            }

            if (score > 0) {
                score *= (item.confidence || 1.0);
                scoredList.push({
                    knowledge: item,
                    score,
                    matchedTokens: Array.from(new Set(matchedTokens)),
                });
            }
        }

        scoredList.sort((a, b) => b.score - a.score);
        return scoredList.slice(0, limit);
    }

    /**
     * Async parallel variant: list stays on main thread, scoring fans out
     * to worker_threads. Falls back to sync `search` on small corpora.
     */
    async searchParallel(query, limit = 4, category = null, workerOptions = {}) {
        if (query && typeof query === "object") {
            workerOptions = category || {};
            category = query.category ?? null;
            limit = query.limit ?? limit;
            query = query.query ?? "";
        }
        const allKnowledge = this.store.listKnowledge({ status: "active", category });
        if (allKnowledge.length === 0 || !query || !query.trim()) return [];
        const queryTokens = tokenize(query);
        if (queryTokens.length === 0) return [];
        try {
            const { searchKnowledgeScored } = await import("./utils/parallel_retrieval.js");
            const scored = await searchKnowledgeScored(allKnowledge, queryTokens, query.toLowerCase().trim(), workerOptions);
            scored.sort((a, b) => b.score - a.score);
            return scored.slice(0, limit);
        } catch {
            return this.search(query, limit, category);
        }
    }
}

export function retrieveKnowledge(query, limit = 4, category = null) {
    const retriever = new KnowledgeRetriever();
    return retriever.search(query, limit, category);
}

/** Async parallel variant (worker-thread scoring, sync fallback). */
export async function retrieveKnowledgeParallel(query, limit = 4, category = null, workerOptions = {}) {
    const retriever = new KnowledgeRetriever();
    return retriever.searchParallel(query, limit, category, workerOptions);
}

export function formatKnowledge(query = null, limit = 10) {
    const store = new KnowledgeStore();
    const retriever = new KnowledgeRetriever(store);

    if (query && query.trim()) {
        const results = retriever.search(query, limit);
        if (results.length === 0) {
            return `📚 No knowledge entries found matching "${query}".`;
        }
        const lines = [`📚 Knowledge Matches for "${query}":`];
        for (const r of results) {
            lines.push(`  • [${r.knowledge.id}] ${r.knowledge.title} (v${r.knowledge.version}, ${r.knowledge.category}, conf: ${r.knowledge.confidence})`);
            lines.push(`    ${r.knowledge.content}`);
        }
        return lines.join("\n");
    }

    const all = store.listKnowledge({ limit });
    if (all.length === 0) {
        return "📚 Knowledge base is empty.";
    }

    const lines = ["📚 Saved Knowledge Base:"];
    for (const k of all) {
        lines.push(`  • [${k.id}] ${k.title} (v${k.version}, ${k.category})`);
        lines.push(`    ${k.content}`);
    }
    return lines.join("\n");
}
