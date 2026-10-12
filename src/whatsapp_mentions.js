/**
 * Shared @character-name callout helpers for the WhatsApp bridge.
 *
 * WhatsApp group chats (remoteJid ending in "@g.us") can get noisy, so the
 * bridge only wakes a persona when its name is explicitly mentioned, e.g.:
 *
 *   "@Parsly what do you think?"
 *   "@Obi Wan and @Whiskers, discuss this"
 *
 * Matching is case-insensitive and tolerant of spaces vs "_" vs "-" vs no
 * separator ("@Obi Wan" == "@Obi_Wan" == "@Obi-Wan" == "@ObiWan").
 * Multi-word names also match on their first word ("@Dungeon" for
 * "Dungeon master") so group callouts stay short.
 *
 * NOTE: bot "@" commands (@help, @make, ...) are NOT character mentions.
 * They are handled separately via isWhatsAppCommandText() / the command
 * blocks in src/whatsapp.js, which always bypass the mention gate.
 */

export function normalizeMentionKey(value) {
    return String(value || "")
        .toLowerCase()
        .trim()
        .replace(/[_-]+/g, " ")
        .replace(/\s+/g, " ");
}

function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build a case-insensitive RegExp matching "@<candidate>" inside free text.
 * `candidate` is a raw character name or id (may contain spaces).
 * Accepts any mix of spaces/underscores/hyphens (or nothing) between words.
 */
function buildMentionPattern(candidate) {
    const key = normalizeMentionKey(candidate);
    if (!key) return null;
    const tokens = key.split(" ").filter(Boolean).map(escapeRegExp);
    if (tokens.length === 0) return null;
    // "@" optionally followed by whitespace, then tokens joined by flexible separators.
    // Trailing boundary: next char must not be a letter/digit/underscore.
    const source = `@\\s*${tokens.join("[\\s_\\-]*")}(?![A-Za-z0-9_])`;
    return new RegExp(source, "i");
}

/**
 * Alias candidates for one character profile: full name, id, plus the first
 * word of each (when long enough to avoid noise) so "@Dungeon" can summon
 * "Dungeon master".
 */
export function characterMentionAliases(character) {
    const aliases = [];
    const seen = new Set();
    for (const raw of [character && character.name, character && character.id]) {
        const key = normalizeMentionKey(raw);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        aliases.push(raw);
        const first = key.split(" ")[0];
        if (first && first.length >= 4 && !seen.has(first)) {
            seen.add(first);
            aliases.push(first);
        }
    }
    return aliases;
}

/**
 * Return the subset of `characters` mentioned in `text`, ordered by first
 * appearance in the text (ties fall back to characters.json order).
 * Each entry is the original character object.
 */
export function findMentionedCharacters(text, characters) {
    const haystack = String(text || "");
    if (!haystack || !haystack.includes("@") || !Array.isArray(characters)) return [];
    const hits = [];
    characters.forEach((character, index) => {
        if (!character) return;
        let earliest = -1;
        for (const alias of characterMentionAliases(character)) {
            const pattern = buildMentionPattern(alias);
            if (!pattern) continue;
            pattern.lastIndex = 0;
            const match = pattern.exec(haystack);
            if (match && (earliest === -1 || match.index < earliest)) {
                earliest = match.index;
            }
        }
        if (earliest !== -1) {
            hits.push({ character, index: earliest, order: index });
        }
    });
    hits.sort((a, b) => (a.index === b.index ? a.order - b.order : a.index - b.index));
    return hits.map((h) => h.character);
}

/**
 * Remove "@CharacterName" mention tokens for the given characters from text.
 * Collapses leftover whitespace. Returns "" when nothing remains.
 */
export function stripCharacterMentions(text, mentionedChars) {
    let out = String(text || "");
    for (const character of mentionedChars || []) {
        for (const alias of characterMentionAliases(character)) {
            const pattern = buildMentionPattern(alias);
            if (!pattern) continue;
            out = out.replace(new RegExp(pattern.source, "gi"), " ");
        }
    }
    return out.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

export function isGroupJid(jid) {
    return String(jid || "").endsWith("@g.us");
}

// Recognized "@" bot commands (also accepted with "/" prefix). These always
// bypass the mention gate, even in groups with no character mention.
// IMPORTANT: keep in sync with the command blocks in src/whatsapp.js
// processPrompt() — anything the server handles must bypass here, or the
// bridge pre-filter will silently swallow it in groups (e.g. @wake/@play).
const COMMAND_WORDS = new Set([
    "help",
    "commands",
    "get-commands",
    "set-security-pin",
    "set-pin",
    "security-pin",
    "remove-security-pin",
    "clear-security-pin",
    "disable-security-pin",
    "unset-security-pin",
    "remove-pin",
    "unlock",
    "unlock-pin",
    "lock",
    "security-status",
    "security",
    "pin-status",
    "make",
    "create-file",
    "opencli",
    "play",
    "youtube-play",
    "spotify",
    "spotify-play",
    "blog",
    "blogpost",
    "post",
    "wordpress",
    "wp",
    "blogger",
    "blogspot",
    "fact-check",
    "factcheck",
    "fact_check",
    "check-fact",
    "verify",
    "browser-search",
    "browser-search-spotify",
    "browser-open",
    "browser-read",
    "browser-shot",
    "browser-status",
    "browser-close",
    "voice-reply",
    "voicereply",
    "voice-mode",
    "voicemode",
    "convert-pdf",
    "pdf",
    "pdf-to-md",
    "convert-md",
    "export-settings",
    "backup",
    "import-settings",
    "restore",
    "remember",
    "register-task",
    "get-tasks",
    "tasks",
    "move-task",
    "delete-task",
    "clear",
    "polling-status",
    "polling",
    "pollers",
    "wake",
    "sleep",
    "proactive",
    "proactive-chat",
    "proactive-status",
    "proactive-timer",
    "proactive-timer-status",
    "proactive-check",
    "set-proactive-timer",
    "set-proactive-check",
    "stop-proactive",
    "stop-proactive-timer",
    "cast",
    "cast-scan",
    "cast-url",
    "cast-player",
    "cast-status",
    "cast-stop",
    "cast-pause",
    "cast-play",
    "cast-resume",
    "cast-device",
    "cast-devices",
    "scan-tv",
    "stop-cast",
    "set-cast-device",
]);

// Prefix rules for command families with free-form suffixes (e.g. @blog-...).
const COMMAND_PREFIXES = ["blog-", "cast-"];

export function isWhatsAppCommandText(text) {
    const trimmed = String(text || "").trim();
    if (!/^[@/]/.test(trimmed)) return false;
    const match = trimmed.match(/^[@/]([A-Za-z][A-Za-z\-_]*)/);
    if (!match) return false;
    const word = match[1].toLowerCase();
    if (COMMAND_WORDS.has(word)) return true;
    return COMMAND_PREFIXES.some((p) => word.startsWith(p));
}
