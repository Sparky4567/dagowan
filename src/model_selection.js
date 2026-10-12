import { DEFAULT_MODELS } from "./providers.js";
import { saveSettings } from "./config.js";
import { saveCharacterStore } from "./characters.js";
import { saveConfig as saveOllamaCliConfig } from "../ollama_cli/src/config.ts";

export const FALLBACK_MODEL = DEFAULT_MODELS.ollama[0];

/** Return the single model used by every LLM-backed assistant feature. */
export function getSharedModel(settings = {}) {
    return String(settings.model || FALLBACK_MODEL).trim() || FALLBACK_MODEL;
}

/** Use the first model returned by Ollama for a fresh installation. */
export async function initializeSharedModel(settings, ollamaClient) {
    if (settings.model) return getSharedModel(settings);

    let model = FALLBACK_MODEL;
    try {
        const list = await ollamaClient.list();
        if (Array.isArray(list?.models) && list.models[0]?.name) {
            model = list.models[0].name;
        }
    } catch {
        // Ollama may not be running during first launch; retain the documented fallback.
    }
    settings.model = model;
    saveSettings(settings);
    return model;
}

/** Keep persona metadata and the standalone coding CLI synchronized with @model. */
export async function setSharedModel(settings, characterStore, model) {
    const selected = String(model || "").trim();
    if (!selected) throw new Error("A model name is required.");

    settings.model = selected;
    if (characterStore?.characters) {
        for (const character of characterStore.characters) character.model = selected;
        saveCharacterStore(characterStore);
    }
    saveSettings(settings);
    try {
        await saveOllamaCliConfig({ model: selected, ollamaUrl: settings.server_url });
    } catch {}
    return selected;
}
