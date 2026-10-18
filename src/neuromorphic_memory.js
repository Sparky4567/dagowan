/**
 * Neuromorphic Cognitive Memory — an additive, plasticity-inspired layer on
 * top of the existing Eliza Cognitive Memory (SQLite).
 *
 * Instead of ranking purely by TF-IDF, each memory carries an *activation*
 * level that:
 *   * spikes when the memory is retrieved/used (recency + frequency),
 *   * decays over time (forgetting curve — computed lazily at read time),
 *   * is boosted by Hebbian links to other memories retrieved in the same
 *     turn ("fire together, wire together"),
 *   * is weighted by importance/confidence/type (valence).
 *
 * Short-term (working) memory = recently spiked, highly activated traces.
 * Long-term memory = durable traces; *consolidation* promotes repeatedly
 * activated traces into higher importance (short → long term), and *pruning*
 * drops traces that have decayed below threshold and sat idle (synaptic
 * pruning).
 *
 * This module is intentionally additive: the existing TF-IDF ranking, the
 * memory schema, and every surface (CLI / Telegram / WhatsApp / voice /
 * dashboard) keep working. Neuromorphic scoring re-orders retrieval results
 * when enabled.
 *
 * Wiring:
 *   * MemoryRetriever.search (src/memory.js) applies neuro-scoring on every
 *     retrieval — so CLI, Telegram, WhatsApp, voice socket and dashboard all
 *     get neuromorphic-ranked memories automatically.
 *   * LearningPipeline.extractWithLLM (src/learning.js) runs consolidation
 *     after each turn on every surface (throttled, non-blocking).
 *   * @neuromorphic-memory / @nc-mem command (src/commands.js + each surface)
 *     exposes status, toggle, consolidate, prune, spikes.
 */

import { getBotDatabase } from "./db/database.js";

const DEFAULT_DECAY_RATE = 0.02;          // per day
const DEFAULT_SPIKE_AMOUNT = 0.15;
const DEFAULT_HEBBIAN_WEIGHT = 0.05;
const DEFAULT_ASSOCIATION_BOOST = 0.30;
const DEFAULT_CONSOLIDATION_THRESHOLD = 0.70;
const DEFAULT_PRUNE_THRESHOLD = 0.05;
const DEFAULT_MAX_SYNAPSES_PER_MEMORY = 8;
const DEFAULT_HEBBIAN_TURN_CAP = 6;       // max co-retrieved memories to link
const DEFAULT_CONSOLIDATE_INTERVAL_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

let defaultInstance = null;

export function getNeuromorphicMemory(db = null) {
    if (!defaultInstance) {
        defaultInstance = new NeuromorphicCognitiveMemory(db || getBotDatabase());
    }
    return defaultInstance;
}

export class NeuromorphicCognitiveMemory {
    constructor(db = null) {
        this.db = db || getBotDatabase();
        this.enabled = true;
        this.decayRate = DEFAULT_DECAY_RATE;
        this.spikeAmount = DEFAULT_SPIKE_AMOUNT;
        this.hebbianWeight = DEFAULT_HEBBIAN_WEIGHT;
        this.associationBoost = DEFAULT_ASSOCIATION_BOOST;
        this.consolidationThreshold = DEFAULT_CONSOLIDATION_THRESHOLD;
        this.pruneThreshold = DEFAULT_PRUNE_THRESHOLD;
        this.maxSynapsesPerMemory = DEFAULT_MAX_SYNAPSES_PER_MEMORY;
        this.hebbianTurnCap = DEFAULT_HEBBIAN_TURN_CAP;
        this.consolidateIntervalMs = DEFAULT_CONSOLIDATE_INTERVAL_MS;
        this._lastConsolidateAt = 0;
    }

    applySettings(settings = {}) {
        this.enabled =
            settings.neuromorphic_memory_enabled !== undefined
                ? settings.neuromorphic_memory_enabled
                : this.enabled;
        this.decayRate =
            Number(settings.neuromorphic_decay_rate) || DEFAULT_DECAY_RATE;
        this.spikeAmount =
            Number(settings.neuromorphic_spike_amount) || DEFAULT_SPIKE_AMOUNT;
        this.hebbianWeight =
            Number(settings.neuromorphic_hebbian_weight) || DEFAULT_HEBBIAN_WEIGHT;
        this.associationBoost =
            Number(settings.neuromorphic_association_boost) ||
            DEFAULT_ASSOCIATION_BOOST;
        this.consolidationThreshold =
            Number(settings.neuromorphic_consolidation_threshold) ||
            DEFAULT_CONSOLIDATION_THRESHOLD;
        this.pruneThreshold =
            Number(settings.neuromorphic_prune_threshold) || DEFAULT_PRUNE_THRESHOLD;
        this.maxSynapsesPerMemory =
            Number(settings.neuromorphic_max_synapses_per_memory) ||
            DEFAULT_MAX_SYNAPSES_PER_MEMORY;
        this.consolidateIntervalMs =
            Number(settings.neuromorphic_consolidate_interval_ms) ||
            DEFAULT_CONSOLIDATE_INTERVAL_MS;
        return this;
    }

    isEnabled() {
        return this.enabled;
    }

    setEnabled(v) {
        this.enabled = !!v;
    }

    ensureSchema() {
        try {
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS memory_traces (
                    memory_id TEXT PRIMARY KEY,
                    activation REAL NOT NULL DEFAULT 0.5,
                    last_spike_at TEXT NOT NULL,
                    decay_rate REAL NOT NULL DEFAULT 0.02,
                    FOREIGN KEY(memory_id) REFERENCES memories(id)
                );
                CREATE TABLE IF NOT EXISTS memory_synapses (
                    id TEXT PRIMARY KEY,
                    source_id TEXT NOT NULL,
                    target_id TEXT NOT NULL,
                    weight REAL NOT NULL DEFAULT 0.1,
                    last_coactivated TEXT NOT NULL,
                    FOREIGN KEY(source_id) REFERENCES memories(id),
                    FOREIGN KEY(target_id) REFERENCES memories(id)
                );
                CREATE INDEX IF NOT EXISTS idx_memory_traces_activation ON memory_traces(activation);
                CREATE INDEX IF NOT EXISTS idx_memory_synapses_source ON memory_synapses(source_id);
                CREATE INDEX IF NOT EXISTS idx_memory_synapses_target ON memory_synapses(target_id);
                CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_synapses_pair ON memory_synapses(source_id, target_id);
            `);
        } catch {}
    }

    nowIso() {
        return new Date().toISOString();
    }

    /**
     * Lazy decay factor in (0.05, 1]. A memory spiked recently decays little;
     * an untouched memory fades toward the floor. Computed at read time so we
     * never have to write decay on every turn.
     */
    decayFactor(trace, now) {
        const d = Number(trace && trace.decay_rate) || this.decayRate;
        const last = trace && trace.last_spike_at
            ? new Date(trace.last_spike_at).getTime()
            : new Date(now).getTime();
        const nowMs = new Date(now).getTime();
        const days = Math.max(0, (nowMs - last) / DAY_MS);
        return Math.max(0.05, Math.exp(-d * days));
    }

    /**
     * Ensure a trace row exists and return it. Does not persist unless
     * spike/consolidate is called.
     */
    getTrace(memoryId, now) {
        const row = this.db.get(
            "SELECT * FROM memory_traces WHERE memory_id = $id",
            { $id: memoryId }
        );
        if (row) return row;
        try {
            this.db.run(
                `INSERT OR IGNORE INTO memory_traces
                 (memory_id, activation, last_spike_at, decay_rate)
                 VALUES ($id, 0.5, $now, $decay)`,
                { $id: memoryId, $now: now, $decay: this.decayRate }
            );
        } catch {}
        return { memory_id: memoryId, activation: 0.5, last_spike_at: now, decay_rate: this.decayRate };
    }

    /**
     * Spike one or more traces: raise activation, stamp last_spike_at = now.
     * Called when a memory is retrieved/used (recency + frequency).
     */
    recordSpikes(memoryIds, now = this.nowIso(), amount = null) {
        const spike = amount === null ? this.spikeAmount : amount;
        if (!memoryIds || memoryIds.length === 0) return;
        try {
            this.db.transaction(() => {
                for (const id of memoryIds) {
                    const row = this.db.get(
                        "SELECT activation FROM memory_traces WHERE memory_id = $id",
                        { $id: id }
                    );
                    const current = row ? Number(row.activation) : 0.5;
                    const next = Math.min(1, Math.max(0, current + spike));
                    this.db.run(
                        `INSERT INTO memory_traces
                         (memory_id, activation, last_spike_at, decay_rate)
                         VALUES ($id, $act, $now, $decay)
                         ON CONFLICT(memory_id) DO UPDATE SET
                           activation = $act,
                           last_spike_at = $now`,
                        {
                            $id: id,
                            $act: next,
                            $now: now,
                            $decay: this.decayRate,
                        }
                    );
                }
            })();
        } catch {}
    }

    /**
     * Hebbian plasticity: memories retrieved together in the same turn wire
     * together. Creates/strengthens a bidirectional synapse between every pair
     * of co-retrieved memories (capped per memory).
     */
    recordHebbian(memoryIds, now = this.nowIso()) {
        if (!memoryIds || memoryIds.length < 2) return;
        const ids = memoryIds.slice(0, this.hebbianTurnCap);
        try {
            this.db.transaction(() => {
                for (let i = 0; i < ids.length; i++) {
                    for (let j = i + 1; j < ids.length; j++) {
                        const a = ids[i];
                        const b = ids[j];
                        if (a === b) continue;
                        for (const [src, tgt] of [[a, b], [b, a]]) {
                            const existing = this.db.get(
                                "SELECT weight FROM memory_synapses WHERE source_id = $s AND target_id = $t",
                                { $s: src, $t: tgt }
                            );
                            let nextWeight;
                            if (existing) {
                                nextWeight = Math.min(1, Number(existing.weight) + this.hebbianWeight);
                            } else {
                                nextWeight = this.hebbianWeight;
                            }
                            this.db.run(
                                `INSERT INTO memory_synapses
                                 (id, source_id, target_id, weight, last_coactivated)
                                 VALUES ($id, $s, $t, $w, $now)
                                 ON CONFLICT(source_id, target_id) DO UPDATE SET
                                   weight = $w,
                                   last_coactivated = $now`,
                                {
                                    $id: `syn_${src}_${tgt}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                                    $s: src,
                                    $t: tgt,
                                    $w: nextWeight,
                                    $now: now,
                                }
                            );
                        }
                    }
                }
                this.enforceSynapseCaps();
            })();
        } catch {}
    }

    enforceSynapseCaps() {
        try {
            const over = this.db.query(
                `SELECT source_id FROM memory_synapses
                 GROUP BY source_id
                 HAVING COUNT(*) > $cap`,
                { $cap: this.maxSynapsesPerMemory }
            );
            for (const row of over) {
                const src = row.source_id;
                const all = this.db.query(
                    `SELECT id FROM memory_synapses WHERE source_id = $s`,
                    { $s: src }
                );
                const keep = new Set(
                    this.db.query(
                        `SELECT id FROM memory_synapses
                         WHERE source_id = $s
                         ORDER BY weight ASC, last_coactivated ASC
                         LIMIT $n`,
                        { $s: src, $n: this.maxSynapsesPerMemory }
                    ).map((r) => r.id)
                );
                for (const r of all) {
                    if (!keep.has(r.id)) {
                        this.db.run("DELETE FROM memory_synapses WHERE id = $id", { $id: r.id });
                    }
                }
            }
        } catch {}
    }

    /**
     * Sum of synapse weights from `memoryId` to the other active memories in
     * this turn — the Hebbian association boost.
     */
    hebbianBoost(memoryId, activeIds) {
        if (!activeIds || activeIds.length === 0) return 0;
        const activeSet = new Set(activeIds);
        try {
            const placeholders = activeIds.map((_, i) => `$t${i}`).join(",");
            const params = {};
            activeIds.forEach((id, i) => { params[`$t${i}`] = id; });
            const rows = this.db.query(
                `SELECT source_id, target_id, weight FROM memory_synapses
                 WHERE source_id = $self AND target_id IN (${placeholders})`,
                { $self: memoryId, ...params }
            );
            let sum = 0;
            for (const r of rows) {
                if (r.target_id !== memoryId && activeSet.has(r.target_id)) {
                    sum += Number(r.weight || 0);
                }
            }
            return sum;
        } catch {}
        return 0;
    }

    typeBoost(type) {
        const t = (type || "fact").toLowerCase();
        if (t === "correction") return 1.30;
        if (t === "project") return 1.15;
        if (t === "goal") return 1.12;
        if (t === "preference") return 1.10;
        if (t === "instruction") return 1.08;
        if (t === "observation") return 1.05;
        return 1.0;
    }

    /**
     * Combine TF-IDF score with neuromorphic factors into an activation score.
     */
    computeActivation(tfidfScore, mem, trace, now, activeIds) {
        const base = Math.max(0, Number(tfidfScore || 0));
        if (base === 0) return 0; // no textual match -> no activation
        const decay = this.decayFactor(trace, now);
        const hebbian = this.hebbianBoost(mem.id, activeIds);
        const association = 1 + hebbian * this.associationBoost;
        const importance = Math.max(0, Math.min(1, Number(mem.importance || 0.5)));
        const confidence = Math.max(0, Math.min(1, Number(mem.confidence || 1.0)));
        const valence = 1 + importance * 0.5 + (confidence - 1) * 0.25;
        let activation = base * decay * association * valence * this.typeBoost(mem.type);
        activation = Math.max(0, Math.min(8, activation));
        return Number(activation.toFixed(4));
    }

    /**
     * Re-score a TF-IDF scored list with neuromorphic activation, re-sort by
     * activation, and record spikes + Hebbian links for the returned set.
     * Returns the re-scored list (caller slices to `limit`).
     */
    applyScoring(scoredList, limit, now = this.nowIso()) {
        if (!this.enabled || !scoredList || scoredList.length === 0) {
            return scoredList;
        }
        this.ensureSchema();
        const activeIds = scoredList
            .map((r) => (r.memory && r.memory.id) || null)
            .filter(Boolean);
        const traces = {};
        if (activeIds.length) {
            try {
                const placeholders = activeIds.map((_, i) => `$t${i}`).join(",");
                const params = {};
                activeIds.forEach((id, i) => { params[`$t${i}`] = id; });
                const rows = this.db.query(
                    `SELECT * FROM memory_traces WHERE memory_id IN (${placeholders})`,
                    params
                );
                for (const r of rows) traces[r.memory_id] = r;
            } catch {}
        }
        for (const r of scoredList) {
            const id = r.memory && r.memory.id;
            if (!id) continue;
            if (!traces[id]) {
                traces[id] = this.getTrace(id, now);
            }
        }
        for (const r of scoredList) {
            const mem = r.memory;
            if (!mem) continue;
            const trace = traces[mem.id] || {
                activation: 0.5,
                last_spike_at: now,
                decay_rate: this.decayRate,
            };
            r.activation = this.computeActivation(r.score, mem, trace, now, activeIds);
            r.neuro = {
                decay: this.decayFactor(trace, now),
                hebbian: this.hebbianBoost(mem.id, activeIds),
                traceActivation: Number(trace.activation || 0.5),
            };
        }
        scoredList.sort((a, b) => (b.activation || 0) - (a.activation || 0));
        // Record plasticity for the returned (top-limit) active set.
        const k = Math.max(1, Math.min(limit || 10, scoredList.length));
        const returned = scoredList.slice(0, k);
        const returnedIds = returned
            .map((r) => (r.memory && r.memory.id) || null)
            .filter(Boolean);
        if (returnedIds.length) {
            this.recordSpikes(returnedIds, now);
            this.recordHebbian(returnedIds, now);
        }
        return scoredList;
    }

    /**
     * Consolidation: repeatedly activated traces are promoted (higher
     * importance/confidence) like short-term -> long-term consolidation.
     * Throttled by consolidateIntervalMs unless `force`.
     */
    consolidate(force = false) {
        if (!this.enabled) return { consolidated: 0, reason: "disabled" };
        const now = Date.now();
        if (!force && now - this._lastConsolidateAt < this.consolidateIntervalMs) {
            return { consolidated: 0, reason: "throttled" };
        }
        this._lastConsolidateAt = now;
        const nowIso = this.nowIso();
        let consolidated = 0;
        try {
            const rows = this.db.query(
                `SELECT m.id, m.importance, m.confidence
                 FROM memories m
                 JOIN memory_traces t ON t.memory_id = m.id
                 WHERE m.status = 'active' AND t.activation >= $thr`,
                { $thr: this.consolidationThreshold }
            );
            this.db.transaction(() => {
                for (const r of rows) {
                    const newImp = Math.min(1, Number(r.importance || 0.5) + 0.05);
                    const newConf = Math.min(1, Number(r.confidence || 1.0) + 0.03);
                    if (
                        newImp !== Number(r.importance) ||
                        newConf !== Number(r.confidence)
                    ) {
                        this.db.run(
                            `UPDATE memories SET importance = $imp, confidence = $conf, updated_at = $now WHERE id = $id`,
                            { $imp: newImp, $conf: newConf, $now: nowIso, $id: r.id }
                        );
                    }
                    consolidated++;
                }
            })();
        } catch {}
        return { consolidated, reason: "ok", at: nowIso };
    }

    /**
     * Pruning: traces decayed below threshold that have been idle for a week
     * are forgotten (status -> forgotten), like synaptic pruning.
     */
    prune() {
        if (!this.enabled) return { pruned: 0, reason: "disabled" };
        const nowIso = this.nowIso();
        let pruned = 0;
        try {
            const candidates = this.db.query(
                `SELECT m.id, m.last_used_at
                 FROM memories m
                 JOIN memory_traces t ON t.memory_id = m.id
                 WHERE m.status = 'active' AND t.activation < $thr`,
                { $thr: this.pruneThreshold }
            );
            for (const r of candidates) {
                const mem = this.db.get(
                    "SELECT last_used_at FROM memories WHERE id = $id",
                    { $id: r.id }
                );
                const lastUsed = mem && mem.last_used_at
                    ? new Date(mem.last_used_at).getTime()
                    : 0;
                const daysIdle = (Date.now() - lastUsed) / DAY_MS;
                if (daysIdle < 7) continue; // don't prune recently-used memories
                this.db.run(
                    `UPDATE memories SET status = 'forgotten', updated_at = $now WHERE id = $id`,
                    { $now: nowIso, $id: r.id }
                );
                pruned++;
            }
        } catch {}
        return { pruned, at: nowIso };
    }

    getStats() {
        let traceCount = 0;
        let synapseCount = 0;
        let avgActivation = 0;
        let highActivation = 0;
        try {
            traceCount = this.db.get("SELECT COUNT(*) as c FROM memory_traces")?.c ?? 0;
            synapseCount = this.db.get("SELECT COUNT(*) as c FROM memory_synapses")?.c ?? 0;
            const agg = this.db.get(
                "SELECT AVG(activation) as avgA, SUM(CASE WHEN activation >= 0.7 THEN 1 ELSE 0 END) as hi FROM memory_traces"
            );
            avgActivation = Number((agg && agg.avgA) || 0);
            highActivation = Number((agg && agg.hi) || 0);
        } catch {}
        return {
            enabled: this.enabled,
            decayRate: this.decayRate,
            spikeAmount: this.spikeAmount,
            hebbianWeight: this.hebbianWeight,
            associationBoost: this.associationBoost,
            consolidationThreshold: this.consolidationThreshold,
            pruneThreshold: this.pruneThreshold,
            maxSynapsesPerMemory: this.maxSynapsesPerMemory,
            traceCount,
            synapseCount,
            avgActivation: Number(avgActivation.toFixed(3)),
            highActivationMemories: highActivation,
        };
    }
}
