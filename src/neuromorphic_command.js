/**
 * Shared control plane for the Neuromorphic Cognitive Memory layer.
 *
 * Surfaces (CLI / Telegram / WhatsApp / voice socket / dashboard) normalize
 * "@" commands to "/" form and call this helper. It returns { handled, reply,
 * settingsChanged } so each surface can render/save in its own way.
 *
 * Neuromorphic memory is global (shared SQLite), so no character scoping is
 * needed here.
 */

import { getNeuromorphicMemory } from "./neuromorphic_memory.js";

export const NEUROMORPHIC_ALIASES = ["/neuromorphic-memory", "/nc-mem"];

function isNeuromorphicCommand(lower) {
    if (lower === "/neuromorphic-memory" || lower === "/nc-mem") return true;
    return lower.startsWith("/neuromorphic-memory ") || lower.startsWith("/nc-mem ");
}

function restOf(lower) {
    return lower.replace(/^\/(neuromorphic-memory|nc-mem)\s*/, "").trim();
}

function helpText() {
    return [
        "🧠 Neuromorphic Cognitive Memory — plasticity layer over Eliza memory",
        "",
        "Subcommands:",
        "  status        — trace/synapse counts, avg activation, enabled state",
        "  toggle [on|off] — enable/disable neuromorphic re-ranking (default on)",
        "  consolidate   — promote highly-activated traces (short -> long term)",
        "  prune         — forget decayed, idle memories (synaptic pruning)",
        "  spikes        — show trace/synapse statistics",
        "  help          — this screen",
        "",
        "Scoring: TF-IDF match × recency decay × Hebbian association × valence",
        "(importance/confidence/type). Consolida­tion runs automatically after",
        "each turn (throttled).",
    ].join("\n");
}

function statusText(s) {
    return [
        "🧠 Neuromorphic Cognitive Memory status",
        `  Enabled: ${s.enabled}`,
        `  Traces: ${s.traceCount} (avg activation ${s.avgActivation}, high-activation ${s.highActivationMemories})`,
        `  Synapses (Hebbian links): ${s.synapseCount}`,
        `  Decay rate: ${s.decayRate}/day | Spike: ${s.spikeAmount} | Hebbian weight: ${s.hebbianWeight}`,
        `  Association boost: ${s.associationBoost}`,
        `  Consolidation threshold: ${s.consolidationThreshold} | Prune threshold: ${s.pruneThreshold}`,
        `  Max synapses/memory: ${s.maxSynapsesPerMemory}`,
    ].join("\n");
}

export function handleNeuromorphicCommand(rawInput, settings, saveSettings) {
    const input = String(rawInput || "").trim();
    const lower = input.toLowerCase();
    if (!isNeuromorphicCommand(lower)) return { handled: false };

    const neuro = getNeuromorphicMemory();
    const rest = restOf(lower);
    const save = () => {
        try { saveSettings(settings); } catch {}
    };

    if (rest === "" || rest === "help" || rest === "?") {
        return { handled: true, reply: helpText() };
    }

    if (rest === "status") {
        return { handled: true, reply: statusText(neuro.getStats()) };
    }

    if (rest === "toggle" || rest.startsWith("toggle ")) {
        const on = rest === "toggle" ? !neuro.isEnabled() : rest.split(" ")[1] !== "off";
        neuro.setEnabled(on);
        save();
        return { handled: true, reply: `🧠 Neuromorphic Cognitive Memory: ${on ? "ON" : "OFF"}` };
    }

    if (rest === "consolidate") {
        const res = neuro.consolidate(true);
        return {
            handled: true,
            reply: `🧠 Consolidated ${res.consolidated} trace(s) (${res.reason}).`,
        };
    }

    if (rest === "prune") {
        const res = neuro.prune();
        return { handled: true, reply: `🧠 Pruned/forgotten ${res.pruned} memory(ies) (${res.at}).` };
    }

    if (rest === "spikes" || rest === "synapses" || rest === "stats") {
        const s = neuro.getStats();
        return {
            handled: true,
            reply:
                `🧠 Traces: ${s.traceCount} | Synapses: ${s.synapseCount} | ` +
                `Avg activation: ${s.avgActivation} | High-activation: ${s.highActivationMemories} | ` +
                `Enabled: ${s.enabled}`,
        };
    }

    return {
        handled: true,
        reply: "⚠️ Unknown neuromorphic subcommand. Use @neuromorphic-memory help.",
    };
}
