import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import { SCHEMA_SQL } from "./schema.js";

const DEFAULT_DB_PATH = path.join(process.cwd(), "data", "bot.db");

export class BotDatabase {
    constructor(filePath = DEFAULT_DB_PATH) {
        this.filePath = filePath;
        if (filePath !== ":memory:") {
            const dir = path.dirname(path.resolve(filePath));
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        }
        this.db = new Database(filePath);
        this.db.exec("PRAGMA journal_mode = WAL;");
        this.db.exec("PRAGMA foreign_keys = ON;");
        this.initSchema();
    }

    initSchema() {
        // SCHEMA_SQL contains CREATE TABLE + CREATE INDEX statements. The
        // character index fails on pre-existing DBs whose memories table
        // predates the character_id column, so create tables first, migrate,
        // then create indexes.
        try {
            this.db.exec(SCHEMA_SQL);
        } catch {
            // Fall through to statement-by-statement init for migrated DBs.
            for (const stmt of SCHEMA_SQL.split(";")) {
                const trimmed = stmt.trim();
                if (!trimmed) continue;
                // Defer index creation until after migration.
                if (/^CREATE\s+INDEX/i.test(trimmed)) continue;
                try { this.db.exec(trimmed + ";"); } catch {}
            }
        }
        this.migrateSchema();
        // Retry any deferred index creation after migration.
        for (const stmt of SCHEMA_SQL.split(";")) {
            const trimmed = stmt.trim();
            if (!trimmed) continue;
            if (/^CREATE\s+INDEX/i.test(trimmed)) {
                try { this.db.exec(trimmed + ";"); } catch {}
            }
        }
    }

    /**
     * Lightweight migrations for databases created before a schema change.
     * Currently ensures `memories.character_id` exists so memories can be
     * scoped per character instead of shared across all bots, plus
     * `memories.language` for the multilanguage memory layer.
     */
    migrateSchema() {
        try {
            const cols = this.db.prepare("PRAGMA table_info(memories)").all() || [];
            const hasCharacterId = cols.some((c) => c.name === "character_id");
            if (!hasCharacterId) {
                this.db.exec("ALTER TABLE memories ADD COLUMN character_id TEXT;");
            }
            const hasLanguage = cols.some((c) => c.name === "language");
            if (!hasLanguage) {
                this.db.exec("ALTER TABLE memories ADD COLUMN language TEXT;");
            }
            // Ensure indexes exist even for migrated DBs.
            this.db.exec("CREATE INDEX IF NOT EXISTS idx_memories_character ON memories(character_id);");
            this.db.exec("CREATE INDEX IF NOT EXISTS idx_memories_language ON memories(language);");
        } catch {}
    }

    get raw() {
        return this.db;
    }

    close() {
        try {
            this.db.close();
        } catch {}
    }

    transaction(fn) {
        return this.db.transaction(fn)();
    }

    query(sql, params = {}) {
        const stmt = this.db.prepare(sql);
        return stmt.all(params);
    }

    get(sql, params = {}) {
        const stmt = this.db.prepare(sql);
        const result = stmt.get(params);
        return result ?? null;
    }

    run(sql, params = {}) {
        const stmt = this.db.prepare(sql);
        stmt.run(params);
    }

    logLearningEvent(eventType, details = {}) {
        const id = `log_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        this.run(
            `INSERT INTO learning_logs (id, event_type, details, timestamp) VALUES ($id, $event_type, $details, $timestamp)`,
            {
                $id: id,
                $event_type: eventType,
                $details: JSON.stringify(details),
                $timestamp: new Date().toISOString(),
            }
        );
    }

    getLogs(limit = 20) {
        const rows = this.query(
            `SELECT * FROM learning_logs ORDER BY timestamp DESC LIMIT ${Math.floor(limit)}`
        );
        return rows.map((r) => ({
            id: r.id,
            eventType: r.event_type,
            details: (() => {
                try {
                    return JSON.parse(r.details);
                } catch {
                    return r.details;
                }
            })(),
            timestamp: r.timestamp,
        }));
    }

    getStats() {
        const activeMem = this.get("SELECT COUNT(*) as count FROM memories WHERE status = 'active'")?.count ?? 0;
        const superMem = this.get("SELECT COUNT(*) as count FROM memories WHERE status = 'superseded'")?.count ?? 0;
        const forgottenMem = this.get("SELECT COUNT(*) as count FROM memories WHERE status = 'forgotten'")?.count ?? 0;
        const activeKnow = this.get("SELECT COUNT(*) as count FROM knowledge WHERE status = 'active'")?.count ?? 0;
        const deprecatedKnow = this.get("SELECT COUNT(*) as count FROM knowledge WHERE status = 'deprecated'")?.count ?? 0;
        const correctionsCount = this.get("SELECT COUNT(*) as count FROM memories WHERE type = 'correction'")?.count ?? 0;
        const approvedRules = this.get("SELECT COUNT(*) as count FROM learned_rules WHERE status = 'approved'")?.count ?? 0;
        const candidateRules = this.get("SELECT COUNT(*) as count FROM learned_rules WHERE status = 'candidate'")?.count ?? 0;
        const totalLogs = this.get("SELECT COUNT(*) as count FROM learning_logs")?.count ?? 0;

        let memoriesByCharacter = [];
        try {
            memoriesByCharacter = this.query(
                `SELECT COALESCE(NULLIF(character_id, ''), 'shared') AS character_id, status, COUNT(*) AS count FROM memories GROUP BY COALESCE(NULLIF(character_id, ''), 'shared'), status ORDER BY character_id, status`
            ).map((r) => ({ characterId: r.character_id, status: r.status, count: r.count }));
        } catch {}

        let memoriesByLanguage = [];
        try {
            memoriesByLanguage = this.query(
                `SELECT COALESCE(NULLIF(LOWER(language), ''), 'shared') AS language, status, COUNT(*) AS count FROM memories GROUP BY COALESCE(NULLIF(LOWER(language), ''), 'shared'), status ORDER BY language, status`
            ).map((r) => ({ language: r.language, status: r.status, count: r.count }));
        } catch {}

        const stratRows = this.query(
            "SELECT strategy, attempts, successes, total_score FROM strategy_stats ORDER BY attempts DESC"
        );
        const strategies = stratRows.map((s) => ({
            strategy: s.strategy,
            attempts: s.attempts,
            successes: s.successes,
            avgScore: s.attempts > 0 ? Number((s.total_score / s.attempts).toFixed(2)) : 0,
        }));

        return {
            activeMemories: activeMem,
            supersededMemories: superMem,
            forgottenMemories: forgottenMem,
            totalMemories: activeMem + superMem + forgottenMem,
            memoriesByCharacter,
            memoriesByLanguage,
            activeKnowledge: activeKnow,
            deprecatedKnowledge: deprecatedKnow,
            totalKnowledge: activeKnow + deprecatedKnow,
            corrections: correctionsCount,
            activeRules: approvedRules,
            candidateRules,
            totalLearningLogs: totalLogs,
            strategies,
        };
    }
}

let defaultDatabaseInstance = null;

export function getBotDatabase(filePath = DEFAULT_DB_PATH) {
    if (!defaultDatabaseInstance || (filePath !== DEFAULT_DB_PATH && defaultDatabaseInstance.filePath !== filePath)) {
        defaultDatabaseInstance = new BotDatabase(filePath);
    }
    return defaultDatabaseInstance;
}
