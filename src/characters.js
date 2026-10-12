import fs from "node:fs";
import path from "node:path";

const CHARACTERS_FILE = "characters.json";
const SCHEMA_VERSION = 1;

function cleanText(val, fallback = "") {
    return typeof val === "string" && val.trim() ? val.trim() : fallback;
}

function normalizeProfile(profile, fallbackModel = "gpt-oss:120b-cloud", fallbackPrompt = "You are a helpful assistant.") {
    let templates = Array.isArray(profile.templates)
        ? profile.templates.map((t) => cleanText(t)).filter(Boolean)
        : [];
    if (templates.length === 0) {
        templates = [fallbackPrompt];
    }

    let temperature = 0.7;
    if (profile.temperature !== undefined) {
        const parsed = parseFloat(profile.temperature);
        if (!isNaN(parsed)) {
            temperature = Math.min(2.0, Math.max(0.0, parsed));
        }
    }

    let selectedTemplates = Array.isArray(profile.selected_templates)
        ? profile.selected_templates.filter(
              (idx) => typeof idx === "number" && idx >= 0 && idx < templates.length
          )
        : [0];
    if (selectedTemplates.length === 0) {
        selectedTemplates = [0];
    }

    return {
        id: cleanText(profile.id, `char-${Date.now().toString(36)}`),
        name: cleanText(profile.name, "Character"),
        description: cleanText(profile.description, ""),
        model: cleanText(profile.model, fallbackModel),
        ollama_endpoint: cleanText(profile.ollama_endpoint, ""),
        temperature,
        telegram_token: cleanText(profile.telegram_token, ""),
        templates,
        selected_templates: selectedTemplates,
    };
}

export function defaultStore(fallbackModel = "gpt-oss:120b-cloud", fallbackPrompt = "You are a helpful assistant.") {
    const mainChar = normalizeProfile(
        {
            id: "main",
            name: "Main Character",
            description: "Default assistant profile.",
            model: fallbackModel,
            templates: [fallbackPrompt],
            selected_templates: [0],
        },
        fallbackModel,
        fallbackPrompt
    );
    return {
        version: SCHEMA_VERSION,
        active_character: mainChar.id,
        characters: [mainChar],
    };
}

export function loadCharacterStore(filePath = CHARACTERS_FILE, fallbackModel = "gpt-oss:120b-cloud", fallbackPrompt = "You are a helpful assistant.") {
    const fallback = defaultStore(fallbackModel, fallbackPrompt);
    if (!fs.existsSync(filePath)) {
        saveCharacterStore(fallback, filePath);
        return fallback;
    }
    try {
        const raw = fs.readFileSync(filePath, "utf8");
        const data = JSON.parse(raw);
        if (!data || !Array.isArray(data.characters)) {
            return fallback;
        }

        const characters = data.characters.map((p) =>
            normalizeProfile(p, fallbackModel, fallbackPrompt)
        );
        if (characters.length === 0) {
            return fallback;
        }

        const ids = new Set(characters.map((c) => c.id));
        let active = data.active_character;
        if (!ids.has(active)) {
            active = characters[0].id;
        }

        return {
            version: SCHEMA_VERSION,
            active_character: active,
            characters,
        };
    } catch {
        return fallback;
    }
}

export function saveCharacterStore(store, filePath = CHARACTERS_FILE) {
    const payload = JSON.stringify(store, null, 2);
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, payload, "utf8");
    fs.renameSync(tmpPath, filePath);
}

export function getActiveCharacter(store) {
    const activeId = store.active_character;
    return store.characters.find((c) => c.id === activeId) || store.characters[0];
}

export function setActiveCharacter(store, characterId, filePath = CHARACTERS_FILE) {
    const target = store.characters.find(
        (c) => c.id === characterId || c.name.toLowerCase() === characterId.toLowerCase()
    );
    if (!target) {
        return { success: false, message: `Character '${characterId}' not found.` };
    }
    store.active_character = target.id;
    saveCharacterStore(store, filePath);
    return { success: true, activeCharacter: target };
}

export function composeSystemTemplate(profile) {
    const selected = new Set(profile.selected_templates || [0]);
    const parts = (profile.templates || []).filter((_, idx) => selected.has(idx));
    return parts.join("\n\n").trim();
}

export function createCharacter(name, model, prompt, options = {}, store = null, filePath = CHARACTERS_FILE) {
    if (!store) {
        store = loadCharacterStore(filePath, model, prompt);
    }
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "char";
    const id = `${slug}-${Date.now().toString(36)}`;
    const newChar = normalizeProfile(
        {
            id,
            name,
            model,
            templates: [prompt],
            description: options.description || "",
            temperature: options.temperature ?? 0.7,
            ollama_endpoint: options.ollama_endpoint || "",
            telegram_token: options.telegram_token || "",
        },
        model,
        prompt
    );

    store.characters.push(newChar);
    saveCharacterStore(store, filePath);
    return newChar;
}

export function updateCharacterToken(store, characterId, token, filePath = CHARACTERS_FILE) {
    const target = store.characters.find(
        (c) => c.id === characterId || c.name.toLowerCase() === characterId.toLowerCase()
    );
    if (!target) {
        return { success: false, message: `Character profile '${characterId}' not found.` };
    }
    target.telegram_token = String(token).trim();
    saveCharacterStore(store, filePath);
    return { success: true, character: target };
}

export function getAllCharacterTelegramBots(store, fallbackToken = "") {
    const bots = [];
    const seenTokens = new Set();

    for (const char of store.characters) {
        const token = (char.telegram_token || "").trim() || (char.id === store.active_character ? fallbackToken.trim() : "");
        if (token && !seenTokens.has(token)) {
            seenTokens.add(token);
            bots.push({
                character: char,
                token,
            });
        }
    }
    return bots;
}

export function listCharacters(store) {
    return store.characters.map((c) => ({
        id: c.id,
        name: c.name,
        model: c.model,
        active: c.id === store.active_character,
        telegram_token: c.telegram_token ? `${c.telegram_token.slice(0, 6)}...` : "none",
        description: c.description,
    }));
}

/**
 * Case-insensitive character lookup by name or id for blog voice
 * resolution ("@Parsly, write a blog post ..." should draft in Parsly's
 * voice, not a generic tone). Accepts "_"/"-"/space variants and the
 * first word of multi-word names ("@Dungeon" -> "Dungeon master").
 * Returns the character object or null.
 */
export function findCharacterByName(store, name) {
    const chars = (store && store.characters) || [];
    const norm = (v) =>
        String(v || "")
            .toLowerCase()
            .trim()
            .replace(/[_-]+/g, " ")
            .replace(/\s+/g, " ");
    const want = norm(name);
    if (!want) return null;
    const wantFlat = want.replace(/\s+/g, "");
    for (const c of chars) {
        if (!c) continue;
        for (const raw of [c.name, c.id]) {
            const key = norm(raw);
            if (!key) continue;
            if (key === want) return c;
            if (key.replace(/\s+/g, "") === wantFlat) return c;
            const first = key.split(" ")[0];
            if (first && first.length >= 4 && (first === want || first === wantFlat)) return c;
        }
    }
    return null;
}
