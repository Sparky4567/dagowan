import fs from "node:fs";
import path from "node:path";
import { loadSettings, saveSettings } from "./config.js";

export class ProactiveChatManager {
    constructor({ settings = null, callback = null } = {}) {
        this.settings = settings || loadSettings();
        this.callback = callback;
        this.timer = null;
        this.lastActivity = new Map(); // chatKey -> timestamp ms
        this.proactiveSent = new Map(); // chatKey -> boolean
    }

    recordActivity(chatKey = "default") {
        this.lastActivity.set(chatKey, Date.now());
        this.proactiveSent.set(chatKey, false);
    }

    setIdleTimerMinutes(minutes) {
        const mins = parseFloat(minutes);
        if (isNaN(mins) || mins <= 0) {
            return { success: false, message: "⚠️ Usage: /set-proactive-timer <minutes> (e.g. /set-proactive-timer 5)" };
        }
        const idleSeconds = Math.round(mins * 60);
        this.settings.proactive_idle_seconds = idleSeconds;
        this.settings.proactive_chat_enabled = true;
        saveSettings(this.settings);

        if (this.timer) {
            this.restartTimer();
        }
        return {
            success: true,
            minutes: mins,
            idleSeconds,
            enabled: true,
            message: `⏱ Proactive chat timer set to ${mins} minute(s) (${idleSeconds}s). Proactive chat is now ENABLED.`,
        };
    }

    setCheckIntervalSeconds(seconds) {
        const secs = parseInt(seconds, 10);
        if (isNaN(secs) || secs < 5) {
            return { success: false, message: "⚠️ Usage: /set-proactive-check <seconds> (min 5 seconds)" };
        }
        this.settings.proactive_check_seconds = secs;
        saveSettings(this.settings);

        if (this.timer) {
            this.restartTimer();
        }
        return {
            success: true,
            checkSeconds: secs,
            message: `⏱ Proactive background check interval set to ${secs} second(s).`,
        };
    }

    toggleProactiveChat(flag = null) {
        if (flag === null || flag === undefined || flag === "") {
            this.settings.proactive_chat_enabled = !this.settings.proactive_chat_enabled;
        } else {
            const lower = String(flag).trim().toLowerCase();
            if (["on", "enable", "enabled", "true", "1"].includes(lower)) {
                this.settings.proactive_chat_enabled = true;
            } else if (["off", "disable", "disabled", "false", "0"].includes(lower)) {
                this.settings.proactive_chat_enabled = false;
            } else {
                this.settings.proactive_chat_enabled = !this.settings.proactive_chat_enabled;
            }
        }
        saveSettings(this.settings);

        const statusStr = this.settings.proactive_chat_enabled ? "ENABLED" : "DISABLED";
        const mins = (this.settings.proactive_idle_seconds / 60).toFixed(1);
        return {
            success: true,
            enabled: this.settings.proactive_chat_enabled,
            message: `⏱ Proactive chat is now ${statusStr} (Idle timer: ${mins} min).`,
        };
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        this.settings.proactive_chat_enabled = false;
        saveSettings(this.settings);
        return {
            success: true,
            message: "⏱ Proactive chat timer stopped and disabled.",
        };
    }

    getStatus() {
        const enabled = !!this.settings.proactive_chat_enabled;
        const idleSeconds = this.settings.proactive_idle_seconds || 300;
        const idleMinutes = Number((idleSeconds / 60).toFixed(2));
        const checkSeconds = this.settings.proactive_check_seconds || 60;
        return {
            enabled,
            idleSeconds,
            idleMinutes,
            checkSeconds,
            formatted: `⏱ Proactive Chat Status:\n  • Status: ${enabled ? "Active / Enabled" : "Disabled"}\n  • Idle Threshold: ${idleMinutes} minute(s) (${idleSeconds} seconds)\n  • Check Frequency: Every ${checkSeconds} seconds`,
        };
    }

    startTimer(callback = null) {
        if (callback) this.callback = callback;
        if (this.timer) clearInterval(this.timer);

        const checkIntervalMs = (this.settings.proactive_check_seconds || 60) * 1000;

        this.timer = setInterval(() => {
            if (!this.settings.proactive_chat_enabled) return;

            const now = Date.now();
            const thresholdMs = (this.settings.proactive_idle_seconds || 300) * 1000;

            for (const [chatKey, lastTime] of this.lastActivity.entries()) {
                const idleMs = now - lastTime;
                const alreadySent = this.proactiveSent.get(chatKey);

                if (idleMs >= thresholdMs && !alreadySent) {
                    this.proactiveSent.set(chatKey, true);
                    const idleMins = (idleMs / 60000).toFixed(1);
                    if (this.callback) {
                        this.callback({
                            chatKey,
                            idleMs,
                            idleMinutes: idleMins,
                        });
                    }
                }
            }
        }, checkIntervalMs);
    }

    restartTimer() {
        this.startTimer();
    }
}

/**
 * Global command handler for proactive chat slash commands across CLI, Telegram, and WhatsApp bridges.
 */
export function handleProactiveCommand(inputStr, settings, proactiveManager = null) {
    const input = String(inputStr || "").trim();
    const lower = input.toLowerCase();

    // 1. /set-proactive-timer <minutes> or /proactive-timer <minutes>
    if (lower.startsWith("/set-proactive-timer ") || lower.startsWith("/proactive-timer ")) {
        const parts = input.split(/\s+/);
        const mins = parts[1];
        if (!mins) {
            return { handled: true, output: "⚠️ Usage: /set-proactive-timer <minutes> (e.g. /set-proactive-timer 5)" };
        }
        if (proactiveManager) {
            const res = proactiveManager.setIdleTimerMinutes(mins);
            return { handled: true, output: res.message };
        } else {
            const num = parseFloat(mins);
            if (isNaN(num) || num <= 0) {
                return { handled: true, output: "⚠️ Usage: /set-proactive-timer <minutes>" };
            }
            settings.proactive_idle_seconds = Math.round(num * 60);
            settings.proactive_chat_enabled = true;
            saveSettings(settings);
            return {
                handled: true,
                output: `⏱ Proactive chat timer set to ${num} minute(s) (${settings.proactive_idle_seconds}s). Proactive chat is now ENABLED.`,
            };
        }
    }

    // 2. /proactive-chat [on|off] or /proactive [on|off]
    if (lower === "/proactive-chat" || lower === "/proactive" || lower.startsWith("/proactive-chat ") || lower.startsWith("/proactive ")) {
        const parts = input.split(/\s+/);
        const flag = parts[1] || null;
        if (proactiveManager) {
            const res = proactiveManager.toggleProactiveChat(flag);
            return { handled: true, output: res.message };
        } else {
            if (flag) {
                const fl = flag.toLowerCase();
                settings.proactive_chat_enabled = ["on", "enable", "enabled", "true", "1"].includes(fl);
            } else {
                settings.proactive_chat_enabled = !settings.proactive_chat_enabled;
            }
            saveSettings(settings);
            const statusStr = settings.proactive_chat_enabled ? "ENABLED" : "DISABLED";
            const mins = ((settings.proactive_idle_seconds || 300) / 60).toFixed(1);
            return { handled: true, output: `⏱ Proactive chat is now ${statusStr} (Idle timer: ${mins} min).` };
        }
    }

    // 3. /proactive-status or /proactive-timer-status
    if (lower === "/proactive-status" || lower === "/proactive-timer-status") {
        if (proactiveManager) {
            return { handled: true, output: proactiveManager.getStatus().formatted };
        } else {
            const enabled = !!settings.proactive_chat_enabled;
            const idleSeconds = settings.proactive_idle_seconds || 300;
            const idleMinutes = (idleSeconds / 60).toFixed(1);
            const checkSeconds = settings.proactive_check_seconds || 60;
            const text = `⏱ Proactive Chat Status:\n  • Status: ${enabled ? "Active / Enabled" : "Disabled"}\n  • Idle Threshold: ${idleMinutes} minute(s) (${idleSeconds} seconds)\n  • Check Frequency: Every ${checkSeconds} seconds`;
            return { handled: true, output: text };
        }
    }

    // 4. /stop-proactive-timer or /stop-proactive
    if (lower === "/stop-proactive-timer" || lower === "/stop-proactive") {
        if (proactiveManager) {
            const res = proactiveManager.stop();
            return { handled: true, output: res.message };
        } else {
            settings.proactive_chat_enabled = false;
            saveSettings(settings);
            return { handled: true, output: "⏱ Proactive chat timer stopped and disabled." };
        }
    }

    // 5. /set-proactive-check <seconds> or /proactive-check <seconds>
    if (lower.startsWith("/set-proactive-check ") || lower.startsWith("/proactive-check ")) {
        const parts = input.split(/\s+/);
        const secs = parts[1];
        if (proactiveManager) {
            const res = proactiveManager.setCheckIntervalSeconds(secs);
            return { handled: true, output: res.message };
        } else {
            const num = parseInt(secs, 10);
            if (isNaN(num) || num < 5) {
                return { handled: true, output: "⚠️ Usage: /set-proactive-check <seconds> (min 5 seconds)" };
            }
            settings.proactive_check_seconds = num;
            saveSettings(settings);
            return { handled: true, output: `⏱ Proactive background check interval set to ${num} second(s).` };
        }
    }

    return { handled: false };
}
