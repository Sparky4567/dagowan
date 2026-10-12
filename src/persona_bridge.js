import { getAllCharacterTelegramBots, findCharacterByName } from "./characters.js";

export const DEFAULT_PERSONA_IDLE_MINUTES = 15;
export const DEFAULT_PERSONA_SWEEP_SECONDS = 60;

export function getPersonaIdleTimeoutMs(settings) {
    const raw = settings?.persona_idle_timeout_minutes ?? settings?.persona_idle_minutes ?? DEFAULT_PERSONA_IDLE_MINUTES;
    const mins = Number(raw);
    if (!Number.isFinite(mins) || mins <= 0) return 0;
    return Math.round(mins * 60 * 1000);
}

export function getPersonaSweepIntervalMs(settings) {
    const raw = settings?.persona_polling_sweep_seconds ?? DEFAULT_PERSONA_SWEEP_SECONDS;
    const secs = Number(raw);
    if (!Number.isFinite(secs) || secs < 5) return DEFAULT_PERSONA_SWEEP_SECONDS * 1000;
    return Math.round(secs * 1000);
}

export function isPersonaOnDemandEnabled(settings) {
    return settings?.persona_polling_on_demand !== false;
}

function resolveCharacter(store, idOrName) {
    if (!store || !Array.isArray(store.characters)) return null;
    const want = String(idOrName || "").trim();
    if (!want) return null;
    const byName = findCharacterByName(store, want);
    if (byName) return byName;
    const lower = want.toLowerCase();
    return store.characters.find((c) => c && (c.id === want || String(c.id || "").toLowerCase() === lower)) || null;
}

/**
 * PersonaPollingBridge — on-demand polling / memory manager for character personas.
 *
 * Problem: starting one Telegram long-poll loop per character (7+ bots) wastes
 * CPU/network even for personas nobody talks to.
 *
 * Policy implemented here:
 * - On boot only the ACTIVE persona polls (`startActiveOnly()`).
 * - Any prompt explicitly routed to another persona calls
 *   `ensurePersona(id)` which starts its poller on demand.
 * - `recordActivity(id)` refreshes the persona's last-seen timestamp
 *   (wired to Telegram handleUpdate / WhatsApp mention routing / CLI).
 * - A lightweight sweeper stops pollers idle longer than
 *   `persona_idle_timeout_minutes` (active persona is never auto-stopped).
 */
export class PersonaPollingBridge {
    constructor({ characterStore, settings, proactiveManager = null, createRunner = null } = {}) {
        this.characterStore = characterStore;
        this.settings = settings || {};
        this.proactiveManager = proactiveManager;
        this.createRunner = createRunner || defaultRunnerFactory(this);
        this.runners = new Map();
        // In-flight start promises keyed by characterId. Without this, two
        // concurrent ensurePersona() calls (fire-and-forget wake from
        // WhatsApp/CLI mention routing, double @wake, etc.) both pass the
        // runners.has() check and spawn duplicate getUpdates loops on the
        // same token — Telegram answers with 409/429.
        this.pending = new Map();
        this.sweepTimer = null;
    }

    botConfigs() {
        const fallback = this.settings.telegram_token || process.env.TELEGRAM_TOKEN || "";
        return getAllCharacterTelegramBots(this.characterStore, fallback);
    }

    getActiveId() {
        return this.characterStore?.active_character || this.settings?.active_character || null;
    }

    isRunning(characterId) {
        return this.runners.has(String(characterId));
    }

    getRunners() {
        return [...this.runners.values()].map((e) => e.runner);
    }

    getRunner(characterId) {
        return this.runners.get(String(characterId))?.runner || null;
    }

    async startRunnerForConfig(cfg, reason = "boot") {
        const characterId = String(cfg.character.id);
        if (this.runners.has(characterId)) {
            this.recordActivity(characterId);
            return { runner: this.runners.get(characterId).runner, started: false };
        }
        // One token = one poller. The fallback global token migrates between
        // personas on @character switch, so a stale runner for the previous
        // active persona may still hold the same token. Reuse it instead of
        // starting a second concurrent getUpdates loop on that token.
        for (const [otherId, entry] of this.runners.entries()) {
            if (entry && entry.token && entry.token === cfg.token) {
                if (otherId !== characterId) {
                    this.runners.delete(otherId);
                    this.runners.set(characterId, {
                        ...entry,
                        characterId,
                        lastActivityAt: Date.now(),
                        startReason: entry.startReason || reason,
                    });
                    try {
                        if (entry.runner && typeof entry.runner.touch === "function") entry.runner.touch();
                    } catch {}
                    // Keep the runner answering as the new owner persona.
                    try {
                        if (entry.runner) entry.runner.characterProfile = cfg.character;
                    } catch {}
                } else {
                    this.recordActivity(characterId);
                }
                return { runner: this.runners.get(characterId).runner, started: false, reusedToken: true };
            }
        }
        // Serialize concurrent starts for the same persona: await the
        // in-flight attempt instead of spawning a duplicate poller.
        if (this.pending.has(characterId)) {
            try {
                const settled = await this.pending.get(characterId);
                if (settled && settled.runner) {
                    this.recordActivity(characterId);
                    return { runner: settled.runner, started: false };
                }
            } catch {}
        }
        const attempt = (async () => {
            const runner = await this.createRunner(cfg);
            if (!runner) return { runner: null, started: false, reason: "factory-null" };
            const ok = await runner.start();
            // start() returning false can mean "already running" (guarded
            // double-start) or a real failure. Only register live runners.
            if (!ok) {
                try {
                    if (typeof runner.stop === "function" && runner.running) runner.stop();
                } catch {}
                return { runner: null, started: false, reason: "start-failed" };
            }
            if (typeof runner.setActivityHook === "function") {
                runner.setActivityHook((id) => this.recordActivity(id));
            } else {
                runner.onActivity = (id) => this.recordActivity(id);
            }
            try { runner.personaBridge = this; } catch {}
            // A concurrent sleep/sweep may have registered something meanwhile;
            // second writer wins cleanup to avoid orphan loops.
            const stale = this.runners.get(characterId);
            if (stale && stale.runner && stale.runner !== runner) {
                try { runner.stop(); } catch {}
                return { runner: stale.runner, started: false };
            }
            this.runners.set(characterId, {
                runner,
                token: cfg.token,
                characterId,
                startedAt: Date.now(),
                lastActivityAt: Date.now(),
                startReason: reason,
            });
            return { runner, started: true };
        })();
        this.pending.set(characterId, attempt);
        try {
            return await attempt;
        } finally {
            if (this.pending.get(characterId) === attempt) this.pending.delete(characterId);
        }
    }

    async startActiveOnly(reason = "boot-active-only") {
        const activeId = this.getActiveId();
        const configs = this.botConfigs();
        const activeCfg = configs.find((c) => String(c.character.id) === String(activeId));
        if (!activeCfg) return [];
        await this.startRunnerForConfig(activeCfg, reason);
        return this.getRunners();
    }

    /** Legacy compat: start every configured bot (used only when on-demand is disabled). */
    async startAll(reason = "boot-all") {
        const out = [];
        for (const cfg of this.botConfigs()) {
            const { runner } = await this.startRunnerForConfig(cfg, reason);
            if (runner) out.push(runner);
        }
        return out;
    }

    async ensurePersona(characterIdOrName, reason = "on-demand") {
        const character = resolveCharacter(this.characterStore, characterIdOrName);
        if (!character) return { runner: null, started: false, reason: "character-not-found" };
        const characterId = String(character.id);
        if (this.runners.has(characterId)) {
            this.recordActivity(characterId);
            return { runner: this.runners.get(characterId).runner, started: false, character };
        }
        const cfg = this.botConfigs().find((c) => String(c.character.id) === characterId);
        if (!cfg) {
            // Character's own token may already be polling under another id
            // (duplicate token configured on two personas — botConfigs()
            // dedupes by token). Share that poller instead of reporting
            // no-token and inviting the caller to retry in a tight loop.
            const ownToken = String(character.telegram_token || "").trim();
            if (ownToken) {
                for (const entry of this.runners.values()) {
                    if (entry && entry.token === ownToken && entry.runner) {
                        return { runner: entry.runner, started: false, character, sharedToken: true };
                    }
                }
            }
            return { runner: null, started: false, reason: "no-token", character };
        }
        return { ...(await this.startRunnerForConfig(cfg, reason)), character };
    }

    async ensurePersonas(charactersOrIds, reason = "on-demand") {
        const out = [];
        for (const c of charactersOrIds || []) {
            const id = c && typeof c === "object" ? c.id : c;
            out.push(await this.ensurePersona(id, reason));
        }
        return out;
    }

    recordActivity(characterId) {
        const key = String(characterId || "");
        if (!key) return false;
        const entry = this.runners.get(key);
        if (!entry) return false;
        entry.lastActivityAt = Date.now();
        if (entry.runner && typeof entry.runner.touch === "function") {
            try { entry.runner.touch(); } catch {}
        }
        return true;
    }

    sweepIdle(now = Date.now()) {
        const timeoutMs = getPersonaIdleTimeoutMs(this.settings);
        if (!timeoutMs) return [];
        const activeId = String(this.getActiveId() || "");
        const stopped = [];
        for (const [characterId, entry] of [...this.runners.entries()]) {
            if (characterId === activeId) continue;
            const idleMs = now - (entry.lastActivityAt || entry.startedAt || now);
            if (idleMs >= timeoutMs) {
                try { entry.runner.stop(); } catch {}
                this.runners.delete(characterId);
                stopped.push({ characterId, idleMs });
            }
        }
        return stopped;
    }

    startIdleSweeper() {
        this.stopIdleSweeper();
        const intervalMs = getPersonaSweepIntervalMs(this.settings);
        this.sweepTimer = setInterval(() => {
            try { this.sweepIdle(); } catch {}
        }, intervalMs);
        if (typeof this.sweepTimer.unref === "function") this.sweepTimer.unref();
        return this.sweepTimer;
    }

    stopIdleSweeper() {
        if (this.sweepTimer) {
            clearInterval(this.sweepTimer);
            this.sweepTimer = null;
        }
    }

    async sleepPersona(characterIdOrName) {
        const character = resolveCharacter(this.characterStore, characterIdOrName);
        if (!character) return { success: false, message: `Character '${characterIdOrName}' not found.` };
        const characterId = String(character.id);
        if (characterId === String(this.getActiveId() || "")) {
            return { success: false, message: `Cannot sleep the active persona "${character.name}" — switch active character first.` };
        }
        const entry = this.runners.get(characterId);
        if (!entry) {
            // A start may still be in flight — drain it first so we don't
            // report "not polling" while a poller is about to register.
            if (this.pending.has(characterId)) {
                try { await this.pending.get(characterId); } catch {}
                const late = this.runners.get(characterId);
                if (late) {
                    try { late.runner.stop(); } catch {}
                    this.runners.delete(characterId);
                    return { success: true, character, message: `Polling stopped for "${character.name}" (idle release).` };
                }
            }
            return { success: false, message: `Persona "${character.name}" is not polling.` };
        }
        try { entry.runner.stop(); } catch {}
        this.runners.delete(characterId);
        return { success: true, character, message: `Polling stopped for "${character.name}" (idle release).` };
    }

    getStatus(now = Date.now()) {
        const activeId = String(this.getActiveId() || "");
        const configs = this.botConfigs();
        const tokenById = new Map(configs.map((c) => [String(c.character.id), c.token]));
        return (this.characterStore?.characters || []).map((c) => {
            const id = String(c.id);
            const entry = this.runners.get(id);
            const last = entry?.lastActivityAt || null;
            return {
                id,
                name: c.name,
                active: id === activeId,
                hasToken: tokenById.has(id),
                polling: !!entry,
                lastActivityAt: last,
                idleMinutes: last ? Number(((now - last) / 60000).toFixed(1)) : null,
                startReason: entry?.startReason || null,
            };
        });
    }

    formatStatus() {
        const rows = this.getStatus();
        const timeout = this.settings?.persona_idle_timeout_minutes ?? DEFAULT_PERSONA_IDLE_MINUTES;
        const lines = [`🔌 Persona Polling Status (idle timeout: ${timeout} min; active persona always polls):`];
        for (const r of rows) {
            const state = r.polling ? "POLLING" : (r.hasToken ? "idle" : "no-token");
            const marks = [r.active ? "active" : null, r.startReason ? `via ${r.startReason}` : null].filter(Boolean).join(", ");
            const idle = r.polling && r.idleMinutes !== null ? ` (idle ${r.idleMinutes}m)` : "";
            lines.push(`  • ${r.name} [${r.id}] — ${state}${marks ? ` (${marks})` : ""}${idle}`);
        }
        return lines.join("\n");
    }

    async stopAll() {
        this.stopIdleSweeper();
        this.pending.clear();
        for (const [, entry] of [...this.runners.entries()]) {
            try { entry.runner.stop(); } catch {}
        }
        this.runners.clear();
    }
}

function defaultRunnerFactory(bridge) {
    return async (cfg) => {
        const { TelegramBotRunner } = await import("./telegram.js");
        return new TelegramBotRunner({
            token: cfg.token,
            characterProfile: cfg.character,
            characterStore: bridge.characterStore,
            settings: bridge.settings,
            proactiveManager: bridge.proactiveManager,
            onActivity: (id) => bridge.recordActivity(id),
        });
    };
}
