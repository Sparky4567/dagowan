import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const SESSIONS_FILE = "chat_sessions.json";
const MAX_RETRIEVED_MESSAGES = 8;

function nowIso() {
    return new Date().toISOString().replace(/\.\d{3}Z$/, "");
}

function readStore(filePath = SESSIONS_FILE) {
    if (!fs.existsSync(filePath)) {
        return { sessions: [] };
    }
    try {
        const raw = fs.readFileSync(filePath, "utf8");
        const data = JSON.parse(raw);
        if (data && Array.isArray(data.sessions)) {
            return data;
        }
    } catch {}
    return { sessions: [] };
}

function writeStore(data, filePath = SESSIONS_FILE) {
    const payload = JSON.stringify(data, null, 2);
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, payload, "utf8");
    fs.renameSync(tmpPath, filePath);
}

function titleFromMessages(messages) {
    for (const msg of messages) {
        if (msg.role === "user" && msg.content) {
            const title = String(msg.content).trim().replace(/\s+/g, " ");
            if (title) {
                return title.length > 60 ? `${title.slice(0, 60)}…` : title;
            }
        }
    }
    return null;
}

function defaultTitle() {
    const dt = new Date().toISOString().replace("T", " ").slice(0, 19);
    return `Conversation ${dt}`;
}

export function createSession(characterId = "main", metadata = null, filePath = SESSIONS_FILE) {
    const now = nowIso();
    const session = {
        id: crypto.randomBytes(16).toString("hex"),
        character_id: characterId,
        participant_character_ids: [characterId],
        title: defaultTitle(),
        custom_title: false,
        created_at: now,
        updated_at: now,
        messages: [],
    };
    if (metadata) {
        session.metadata = { ...metadata };
    }

    const store = readStore(filePath);
    store.sessions.push(session);
    writeStore(store, filePath);
    return session;
}

export function remoteSession(platform, remoteChatId, characterId = "main", title = null, filePath = SESSIONS_FILE) {
    const cleanPlatform = String(platform).trim().toLowerCase();
    const cleanRemoteId = String(remoteChatId).trim();
    if (!cleanPlatform || !cleanRemoteId) {
        throw new Error("Platform and remote chat ID are required.");
    }

    const store = readStore(filePath);
    for (const session of store.sessions) {
        const meta = session.metadata || {};
        if (
            session.character_id === characterId &&
            meta.platform === cleanPlatform &&
            meta.remote_chat_id === cleanRemoteId
        ) {
            return session;
        }
    }

    const now = nowIso();
    const newSession = {
        id: crypto.randomBytes(16).toString("hex"),
        character_id: characterId,
        participant_character_ids: [characterId],
        title: title || `${cleanPlatform.charAt(0).toUpperCase() + cleanPlatform.slice(1)} ${cleanRemoteId}`,
        custom_title: Boolean(title),
        created_at: now,
        updated_at: now,
        messages: [],
        metadata: {
            platform: cleanPlatform,
            remote_chat_id: cleanRemoteId,
        },
    };

    store.sessions.push(newSession);
    writeStore(store, filePath);
    return newSession;
}

export function listSessions(characterId = null, filePath = SESSIONS_FILE) {
    const store = readStore(filePath);
    let sessions = store.sessions;

    if (characterId) {
        sessions = sessions.filter(
            (s) => s.character_id === characterId || (s.participant_character_ids && s.participant_character_ids.includes(characterId))
        );
    }

    sessions.forEach((s) => {
        if (!s.title || s.title === "New conversation") {
            s.title = s.created_at ? `Conversation ${s.created_at.replace("T", " ").slice(0, 19)}` : `Conversation ${s.id.slice(0, 8)}`;
        }
    });

    return sessions.sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));
}

export function loadSession(sessionId, characterId = null, filePath = SESSIONS_FILE) {
    const store = readStore(filePath);
    const session = store.sessions.find((s) => s.id === sessionId);
    if (!session) return null;
    if (characterId && session.character_id !== characterId && (!session.participant_character_ids || !session.participant_character_ids.includes(characterId))) {
        return null;
    }
    return session;
}

export function saveSession(sessionId, messages, characterId = null, filePath = SESSIONS_FILE) {
    const store = readStore(filePath);
    const session = store.sessions.find((s) => s.id === sessionId);
    if (!session) return null;
    if (characterId && session.character_id !== characterId && (!session.participant_character_ids || !session.participant_character_ids.includes(characterId))) {
        return null;
    }

    session.messages = messages;
    if (!session.custom_title) {
        const generated = titleFromMessages(messages);
        if (generated) {
            session.title = generated;
        }
    }
    session.updated_at = nowIso();
    writeStore(store, filePath);
    return session;
}

export function renameSession(sessionId, title, characterId = null, filePath = SESSIONS_FILE) {
    const cleanTitle = String(title).trim().replace(/\s+/g, " ");
    if (!cleanTitle) {
        return { success: false, message: "Session title cannot be empty." };
    }

    const store = readStore(filePath);
    const session = store.sessions.find((s) => s.id === sessionId);
    if (!session) {
        return { success: false, message: `Session #${sessionId} not found.` };
    }
    if (characterId && session.character_id !== characterId && (!session.participant_character_ids || !session.participant_character_ids.includes(characterId))) {
        return { success: false, message: `Session #${sessionId} not found.` };
    }

    session.title = cleanTitle.slice(0, 100);
    session.custom_title = true;
    session.updated_at = nowIso();
    writeStore(store, filePath);
    return { success: true, session };
}

export function deleteSession(sessionId, characterId = null, filePath = SESSIONS_FILE) {
    const store = readStore(filePath);
    const target = store.sessions.find((s) => s.id === sessionId);
    if (!target) {
        return { success: false, message: `Session #${sessionId} not found.` };
    }
    if (characterId && target.character_id !== characterId && (!target.participant_character_ids || !target.participant_character_ids.includes(characterId))) {
        return { success: false, message: `Session #${sessionId} not found.` };
    }
    const initialLen = store.sessions.length;
    store.sessions = store.sessions.filter((s) => s.id !== sessionId);

    if (store.sessions.length === initialLen) {
        return { success: false, message: `Session #${sessionId} not found.` };
    }

    writeStore(store, filePath);
    return { success: true };
}

/**
 * Searches across session history for relevant past chat messages.
 * Scoped per character: when `characterId` is provided only sessions owned
 * by (or including) that character are searched. Passing null searches all
 * characters (admin/debug use only) — all product call sites must pass the
 * active character id to prevent cross-bot history leakage.
 */
export function retrieveSessionContext(
    query,
    excludeSessionId = null,
    limit = MAX_RETRIEVED_MESSAGES,
    characterId = null,
    filePath = SESSIONS_FILE
) {
    // Allow (query, excludeSessionId, characterId) and options-object shapes.
    if (excludeSessionId && typeof excludeSessionId === "object") {
        const opts = excludeSessionId;
        excludeSessionId = opts.excludeSessionId ?? null;
        limit = opts.limit ?? MAX_RETRIEVED_MESSAGES;
        characterId = opts.characterId ?? opts.character_id ?? characterId;
        filePath = opts.filePath ?? SESSIONS_FILE;
    } else if (typeof limit === "string") {
        filePath = limit;
        limit = MAX_RETRIEVED_MESSAGES;
    } else if (limit && typeof limit === "object") {
        const opts = limit;
        limit = opts.limit ?? MAX_RETRIEVED_MESSAGES;
        characterId = opts.characterId ?? opts.character_id ?? characterId;
        filePath = opts.filePath ?? SESSIONS_FILE;
    } else if (typeof characterId === "string" && characterId.endsWith(".json")) {
        filePath = characterId;
        characterId = null;
    }
    const scope = characterId ? String(characterId).trim() || null : null;
    if (!query || !query.trim()) return [];

    const queryWords = new Set(
        query.toLowerCase().match(/\w+/g) || []
    );
    if (queryWords.size === 0) return [];

    const store = readStore(filePath);
    const scored = [];

    for (const session of store.sessions) {
        if (excludeSessionId && session.id === excludeSessionId) continue;
        if (scope && session.character_id !== scope && !(session.participant_character_ids && session.participant_character_ids.includes(scope))) continue;

        for (const msg of session.messages || []) {
            if (msg.role !== "user" && msg.role !== "assistant") continue;
            const content = String(msg.content || "").trim();
            const msgWords = new Set(content.toLowerCase().match(/\w+/g) || []);

            let score = 0;
            for (const word of queryWords) {
                if (msgWords.has(word)) score++;
            }

            if (score > 0) {
                scored.push({
                    score,
                    updated_at: session.updated_at || "",
                    session_title: session.title || "Previous conversation",
                    character_id: session.character_id || null,
                    role: msg.role,
                    content,
                });
            }
        }
    }

    scored.sort((a, b) => b.score - a.score || b.updated_at.localeCompare(a.updated_at));

    return scored.slice(0, limit).map((item) => ({
        session_title: item.session_title,
        character_id: item.character_id,
        role: item.role,
        content: item.content,
    }));
}

/**
 * Async parallel variant: file read stays on main thread, word-overlap
 * scoring fans out to worker_threads for large histories.
 */
export async function retrieveSessionContextParallel(
    query,
    excludeSessionId = null,
    limit = MAX_RETRIEVED_MESSAGES,
    characterId = null,
    filePath = SESSIONS_FILE,
    workerOptions = {}
) {
    if (excludeSessionId && typeof excludeSessionId === "object") {
        const opts = excludeSessionId;
        workerOptions = limit && typeof limit === "object" ? limit : {};
        excludeSessionId = opts.excludeSessionId ?? null;
        limit = opts.limit ?? MAX_RETRIEVED_MESSAGES;
        characterId = opts.characterId ?? opts.character_id ?? characterId;
        filePath = opts.filePath ?? SESSIONS_FILE;
    } else if (typeof limit === "string") {
        filePath = limit;
        limit = MAX_RETRIEVED_MESSAGES;
    } else if (limit && typeof limit === "object") {
        const opts = limit;
        workerOptions = opts.workerOptions || {};
        limit = opts.limit ?? MAX_RETRIEVED_MESSAGES;
        characterId = opts.characterId ?? opts.character_id ?? characterId;
        filePath = opts.filePath ?? SESSIONS_FILE;
    } else if (typeof characterId === "string" && characterId.endsWith(".json")) {
        filePath = characterId;
        characterId = null;
    } else if (characterId && typeof characterId === "object") {
        workerOptions = characterId;
        characterId = workerOptions.characterId ?? workerOptions.character_id ?? null;
    }
    try {
        const scope = characterId ? String(characterId).trim() || null : null;
        if (!query || !query.trim()) return [];
        const queryWords = Array.from(new Set(query.toLowerCase().match(/\w+/g) || []));
        if (queryWords.length === 0) return [];
        const store = readStore(filePath);
        const flat = [];
        for (const session of store.sessions) {
            if (excludeSessionId && session.id === excludeSessionId) continue;
            if (scope && session.character_id !== scope && !(session.participant_character_ids?.includes(scope))) continue;
            for (const msg of session.messages || []) {
                if (msg.role !== "user" && msg.role !== "assistant") continue;
                flat.push({
                    session_title: session.title || "Previous conversation",
                    character_id: session.character_id || null,
                    role: msg.role,
                    content: String(msg.content || "").trim(),
                    updated_at: session.updated_at || "",
                });
            }
        }
        const { scoreSessionMessagesScored } = await import("./utils/parallel_retrieval.js");
        const scored = await scoreSessionMessagesScored(flat, queryWords, workerOptions);
        scored.sort((a, b) => b.score - a.score || String(b.updated_at).localeCompare(String(a.updated_at)));
        return scored.slice(0, limit).map(({ session_title, character_id, role, content }) => ({
            session_title, character_id, role, content,
        }));
    } catch {
        return retrieveSessionContext(query, excludeSessionId, limit, characterId, filePath);
    }
}
