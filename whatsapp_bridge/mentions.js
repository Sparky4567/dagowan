/**
 * CJS mirror of ../src/whatsapp_mentions.js for the Baileys bridge process.
 * Keep the matching semantics identical; the bridge only uses it for a cheap
 * pre-filter so group chatter without an @character-name mention never pays
 * for an HTTP + LLM round-trip. The authoritative gate lives server-side in
 * src/whatsapp.js (which re-checks transcribed voice text too).
 */

function normalizeMentionKey(value) {
    return String(value || "")
        .toLowerCase()
        .trim()
        .replace(/[_-]+/g, " ")
        .replace(/\s+/g, " ");
}

function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildMentionPattern(candidate) {
    const key = normalizeMentionKey(candidate);
    if (!key) return null;
    const tokens = key.split(" ").filter(Boolean).map(escapeRegExp);
    if (tokens.length === 0) return null;
    const source = `@\\s*${tokens.join("[\\s_\\-]*")}(?![A-Za-z0-9_])`;
    return new RegExp(source, "i");
}

function characterMentionAliases(character) {
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

function findMentionedCharacters(text, characters) {
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

function isGroupJid(jid) {
    return String(jid || "").endsWith("@g.us");
}

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
]);

// Prefix rules for command families with free-form suffixes (e.g. @blog-...).
const COMMAND_PREFIXES = ["blog-"];

function isWhatsAppCommandText(text) {
    const trimmed = String(text || "").trim();
    if (!/^[@/]/.test(trimmed)) return false;
    const match = trimmed.match(/^[@/]([A-Za-z][A-Za-z\-_]*)/);
    if (!match) return false;
    const word = match[1].toLowerCase();
    if (COMMAND_WORDS.has(word)) return true;
    return COMMAND_PREFIXES.some((p) => word.startsWith(p));
}

module.exports = {
    normalizeMentionKey,
    findMentionedCharacters,
    isGroupJid,
    isWhatsAppCommandText,
};
