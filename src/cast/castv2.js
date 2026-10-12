// ---------------------------------------------------------------------------
// Google Cast V2 client, pure Bun + JavaScript (node:tls, hand-rolled
// minimal protobuf for the CastMessage schema — field subset 1..7).
// Short-lived connections per operation (no daemon thread): each @cast-*
// command opens TLS to <host>:8009, runs its flow, and closes.
// ---------------------------------------------------------------------------

export const CAST_PORT = 8009;
export const NS_CONNECTION = "urn:x-cast:com.google.cast.tp.connection";
export const NS_HEARTBEAT = "urn:x-cast:com.google.cast.tp.heartbeat";
export const NS_RECEIVER = "urn:x-cast:com.google.cast.receiver";
export const NS_MEDIA = "urn:x-cast:com.google.cast.media";
export const NS_YOUTUBE = "urn:x-cast:com.google.youtube.mdx";

export const APP_DMR = "CC1AD845"; // Default Media Receiver
export const APP_BACKDROP = "E8C28D3C";
export const APP_YOUTUBE = "233637DE";

export const SENDER_ID = "sender-0";
export const RECEIVER_ID = "receiver-0";

// --- minimal protobuf (varint + length-delimited only) ---------------------

function encodeVarint(value) {
    let v = Number(value);
    if (!Number.isSafeInteger(v) || v < 0) throw new Error(`Bad varint: ${value}`);
    const out = [];
    do {
        let b = v % 128;
        v = Math.floor(v / 128);
        if (v > 0) b |= 0x80;
        out.push(b);
    } while (v > 0);
    return Buffer.from(out);
}

function encodeField(key, wireType, bytes) {
    return Buffer.concat([encodeVarint((key << 3) | wireType), bytes]);
}

function encodeStringField(key, str) {
    const bytes = Buffer.from(String(str), "utf8");
    return encodeField(key, 2, Buffer.concat([encodeVarint(bytes.length), bytes]));
}

/**
 * Encode a CastMessage. Schema: protocol_version=1, source_id=2,
 * destination_id=3, namespace=4, payload_type=5 (0=STRING), payload_utf8=6.
 */
export function encodeCastMessage({ sourceId, destinationId, namespace, payloadUtf8, protocolVersion = 0, payloadType = 0 }) {
    return Buffer.concat([
        encodeField(1, 0, encodeVarint(protocolVersion)),
        encodeStringField(2, sourceId),
        encodeStringField(3, destinationId),
        encodeStringField(4, namespace),
        encodeField(5, 0, encodeVarint(payloadType)),
        encodeStringField(6, typeof payloadUtf8 === "string" ? payloadUtf8 : JSON.stringify(payloadUtf8)),
    ]);
}

/** Frame for the wire: uint32 BE length + protobuf payload. */
export function frameMessage(protoBytes) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(protoBytes.length, 0);
    return Buffer.concat([len, protoBytes]);
}

function decodeVarint(buf, pos) {
    let value = 0;
    let shift = 0;
    for (let i = 0; i < 10; i++) {
        if (pos >= buf.length) throw new Error("Truncated varint");
        const b = buf[pos++];
        value += (b & 0x7f) * 2 ** shift;
        shift += 7;
        if ((b & 0x80) === 0) return { value, next: pos };
    }
    throw new Error("Varint overflow");
}

/** Decode CastMessage bytes into a plain object (unknown fields skipped). */
export function decodeCastMessage(buf) {
    const data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    const msg = {};
    let pos = 0;
    while (pos < data.length) {
        const { value: tag, next: p1 } = decodeVarint(data, pos);
        pos = p1;
        const key = tag >> 3;
        const wire = tag & 7;
        if (wire === 0) {
            const { value, next } = decodeVarint(data, pos);
            pos = next;
            if (key === 1) msg.protocolVersion = value;
            else if (key === 5) msg.payloadType = value;
        } else if (wire === 2) {
            const { value: len, next: p2 } = decodeVarint(data, pos);
            pos = p2;
            if (pos + len > data.length) throw new Error("Truncated length-delimited field");
            const bytes = data.subarray(pos, pos + len);
            pos += len;
            const str = bytes.toString("utf8");
            if (key === 2) msg.sourceId = str;
            else if (key === 3) msg.destinationId = str;
            else if (key === 4) msg.namespace = str;
            else if (key === 6) msg.payloadUtf8 = str;
        } else if (wire === 1) {
            pos += 8;
        } else if (wire === 5) {
            pos += 4;
        } else {
            throw new Error(`Unsupported wire type ${wire}`);
        }
        if (pos > data.length) throw new Error("Protobuf overrun");
    }
    return msg;
}

/** Split a byte stream into framed protobuf payloads (keeps remainder). */
export function splitFrames(buffer) {
    const messages = [];
    let rest = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    while (rest.length >= 4) {
        const len = rest.readUInt32BE(0);
        if (len > 64 * 1024 * 1024) throw new Error("Cast frame too large");
        if (rest.length < 4 + len) break;
        messages.push(rest.subarray(4, 4 + len));
        rest = rest.subarray(4 + len);
    }
    return { messages, rest };
}

// --- message builders (pure, unit-tested) ----------------------------------

let requestIdCounter = Math.floor(Math.random() * 100000);

export function nextRequestId() {
    requestIdCounter += 1;
    return requestIdCounter;
}

export function buildConnect() {
    return { type: "CONNECT" };
}

export function buildGetStatus(requestId = nextRequestId()) {
    return { type: "GET_STATUS", requestId };
}

export function buildLaunch(appId, requestId = nextRequestId()) {
    return { type: "LAUNCH", appId, requestId };
}

export function buildReceiverStop(sessionId, requestId = nextRequestId()) {
    return { type: "STOP", sessionId, requestId };
}

export function buildLoad({ sessionId, contentId, contentType = "video/mp4", streamType = "BUFFERED", autoplay = true, currentTime = 0, requestId = nextRequestId() }) {
    return {
        type: "LOAD",
        requestId,
        sessionId,
        media: { contentId, contentType, streamType },
        autoplay,
        currentTime,
    };
}

export function buildMediaCommand(type, { requestId = nextRequestId() } = {}) {
    return { type, requestId };
}

// --- status parsers (pure, unit-tested) ------------------------------------

export function parseReceiverStatus(payload) {
    const apps = Array.isArray(payload?.status?.applications) ? payload.status.applications : [];
    return apps.map((a) => ({
        appId: a.appId || "",
        displayName: a.displayName || "",
        sessionId: a.sessionId || "",
        transportId: a.transportId || "",
        namespaces: Array.isArray(a.namespaces) ? a.namespaces.map((n) => n.name) : [],
        statusText: a.statusText || "",
    }));
}

export function findAppSession(apps, appId) {
    return (apps || []).find((a) => a.appId === appId && a.transportId) || null;
}

export function parseMediaStatus(payload) {
    const st = Array.isArray(payload?.status) && payload.status.length > 0 ? payload.status[0] : null;
    if (!st) return null;
    return {
        mediaSessionId: st.mediaSessionId ?? null,
        playerState: st.playerState || "UNKNOWN",
        currentTime: Number(st.currentTime || 0),
        contentId: st.media?.contentId || "",
        duration: Number(st.media?.duration || 0),
    };
}

// --- YouTube helpers --------------------------------------------------------

const YT_ID_RE = /^[A-Za-z0-9_-]{6,}$/;

/** Extract a YouTube video ID from watch / youtu.be / shorts / embed / live URLs. */
export function extractYoutubeVideoId(url) {
    const raw = String(url || "").trim();
    if (YT_ID_RE.test(raw)) return raw; // already a bare ID
    let u;
    try {
        u = new URL(raw);
    } catch {
        return null;
    }
    const host = u.hostname.toLowerCase().replace(/^m\./, "").replace(/^www\./, "");
    if (host === "youtu.be") {
        const id = u.pathname.split("/").filter(Boolean)[0] || "";
        return YT_ID_RE.test(id) ? id : null;
    }
    if (host.endsWith("youtube.com") || host.endsWith("youtube-nocookie.com")) {
        const v = u.searchParams.get("v") || "";
        if (YT_ID_RE.test(v)) return v;
        for (const prefix of ["/shorts/", "/embed/", "/live/", "/v/"]) {
            if (u.pathname.startsWith(prefix)) {
                const id = u.pathname.slice(prefix.length).split("/").filter(Boolean)[0] || "";
                if (YT_ID_RE.test(id)) return id;
            }
        }
    }
    return null;
}

export function isYoutubeUrl(url) {
    return extractYoutubeVideoId(url) !== null && !YT_ID_RE.test(String(url || "").trim());
}

/** Parse t=/start= (90, 1m30s, 1h2m3s) into seconds. */
export function parseYoutubeStartTime(url) {
    let u;
    try {
        u = new URL(String(url));
    } catch {
        return 0;
    }
    const raw = u.searchParams.get("t") || u.searchParams.get("start") || u.searchParams.get("time_continue") || "";
    if (!raw) return 0;
    if (/^\d+$/.test(raw)) return Number(raw);
    const m = String(raw).match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/);
    if (!m || (!m[1] && !m[2] && !m[3])) return 0;
    return Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0);
}

// --- short-lived TLS client -------------------------------------------------

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

class CastConnection {
    constructor(socket) {
        this.socket = socket;
        this.buffer = Buffer.alloc(0);
        this.waiters = [];
        this.closed = false;
        this.heartbeat = null;
        socket.on("data", (chunk) => this.onData(chunk));
        socket.on("close", () => this.onClose());
        socket.on("error", () => this.onClose());
    }

    onData(chunk) {
        this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
        try {
            const { messages, rest } = splitFrames(this.buffer);
            this.buffer = rest;
            for (const m of messages) {
                let decoded;
                try {
                    decoded = decodeCastMessage(m);
                } catch {
                    continue;
                }
                // Auto-reply to heartbeat pings so the device keeps us connected.
                if (decoded.namespace === NS_HEARTBEAT) {
                    try {
                        const body = JSON.parse(decoded.payloadUtf8 || "{}");
                        if (body.type === "PING") this.sendRaw(NS_HEARTBEAT, RECEIVER_ID, { type: "PONG" });
                    } catch {}
                }
                const waiters = this.waiters.splice(0);
                for (const w of waiters) {
                    try {
                        if (w(decoded)) continue;
                    } catch {}
                    this.waiters.push(w);
                }
            }
        } catch {
            this.buffer = Buffer.alloc(0);
        }
    }

    onClose() {
        this.closed = true;
        try {
            if (this.heartbeat) clearInterval(this.heartbeat);
        } catch {}
        const waiters = this.waiters.splice(0);
        for (const w of waiters) {
            try {
                w(null);
            } catch {}
        }
    }

    sendRaw(namespace, destinationId, payload) {
        if (this.closed) throw new Error("Cast connection closed");
        const bytes = frameMessage(
            encodeCastMessage({ sourceId: SENDER_ID, destinationId, namespace, payloadUtf8: payload })
        );
        this.socket.write(bytes);
    }

    /** Resolve on first message matching pred; null on close/timeout. */
    waitFor(pred, timeoutMs = 10000) {
        return new Promise((resolve) => {
            if (this.closed) return resolve(null);
            const timer = setTimeout(() => {
                this.waiters = this.waiters.filter((w) => w !== waiter);
                resolve(null);
            }, timeoutMs);
            const waiter = (msg) => {
                if (msg === null) {
                    clearTimeout(timer);
                    resolve(null);
                    return true;
                }
                let ok = false;
                try {
                    ok = pred(msg);
                } catch {}
                if (ok) {
                    clearTimeout(timer);
                    resolve(msg);
                    return true;
                }
                return false;
            };
            this.waiters.push(waiter);
        });
    }

    async close() {
        try {
            if (this.heartbeat) clearInterval(this.heartbeat);
        } catch {}
        try {
            this.socket.destroy();
        } catch {}
    }
}

function payloadOf(msg) {
    try {
        return JSON.parse(msg?.payloadUtf8 || "{}");
    } catch {
        return {};
    }
}

async function openConnection(host, port = CAST_PORT, { timeoutMs = 8000 } = {}) {
    const tls = await import("node:tls");
    const socket = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Cast TLS connect to ${host}:${port} timed out`)), timeoutMs);
        const s = tls.connect({ host, port, rejectUnauthorized: false }, () => {
            clearTimeout(timer);
            resolve(s);
        });
        s.once("error", (err) => {
            clearTimeout(timer);
            reject(err);
        });
    });
    const conn = new CastConnection(socket);
    conn.heartbeat = setInterval(() => {
        try {
            conn.sendRaw(NS_HEARTBEAT, RECEIVER_ID, { type: "PING" });
        } catch {}
    }, 5000);
    try {
        if (typeof conn.heartbeat.unref === "function") conn.heartbeat.unref();
    } catch {}
    conn.sendRaw(NS_CONNECTION, RECEIVER_ID, buildConnect());
    return conn;
}

/** GET_STATUS from the receiver; returns parsed app sessions. */
export async function castReceiverStatus(host, { port = CAST_PORT, timeoutMs = 8000 } = {}) {
    const conn = await openConnection(host, port, { timeoutMs });
    try {
        const reqId = nextRequestId();
        conn.sendRaw(NS_RECEIVER, RECEIVER_ID, buildGetStatus(reqId));
        const msg = await conn.waitFor(
            (m) =>
                m.namespace === NS_RECEIVER &&
                (payloadOf(m).requestId === reqId || payloadOf(m).type === "RECEIVER_STATUS"),
            timeoutMs
        );
        if (!msg) throw new Error("No receiver status from Chromecast (timeout)");
        return parseReceiverStatus(payloadOf(msg));
    } finally {
        await conn.close();
    }
}

/**
 * Ensure the Default Media Receiver is running and return its session.
 * Launches it when needed and waits for the session to appear.
 */
export async function ensureDmrSession(host, { port = CAST_PORT, timeoutMs = 20000 } = {}) {
    const conn = await openConnection(host, port, { timeoutMs: 8000 });
    try {
        const reqId = nextRequestId();
        conn.sendRaw(NS_RECEIVER, RECEIVER_ID, buildGetStatus(reqId));
        let msg = await conn.waitFor(
            (m) => m.namespace === NS_RECEIVER && payloadOf(m).type === "RECEIVER_STATUS",
            8000
        );
        let apps = msg ? parseReceiverStatus(payloadOf(msg)) : [];
        let session = findAppSession(apps, APP_DMR);
        if (!session) {
            const launchId = nextRequestId();
            conn.sendRaw(NS_RECEIVER, RECEIVER_ID, buildLaunch(APP_DMR, launchId));
            const deadline = Date.now() + timeoutMs;
            while (Date.now() < deadline) {
                msg = await conn.waitFor(
                    (m) => m.namespace === NS_RECEIVER && payloadOf(m).type === "RECEIVER_STATUS",
                    Math.max(1000, deadline - Date.now())
                );
                if (!msg) break;
                apps = parseReceiverStatus(payloadOf(msg));
                session = findAppSession(apps, APP_DMR);
                if (session) break;
                await sleep(500);
            }
        }
        if (!session) throw new Error("Default Media Receiver did not start (is the Chromecast idle and reachable?)");
        return { conn, session, keepOpen: true };
    } catch (err) {
        await conn.close();
        throw err;
    }
}

/**
 * LOAD contentId on the Default Media Receiver. Returns media status.
 * Keeps the flow on one connection: launch -> connect(transport) -> LOAD.
 */
export async function castLoadMedia(host, { contentId, contentType = "video/mp4", streamType = "BUFFERED", currentTime = 0, port = CAST_PORT, timeoutMs = 25000 } = {}) {
    const { conn, session } = await ensureDmrSession(host, { port, timeoutMs });
    try {
        conn.sendRaw(NS_CONNECTION, session.transportId, buildConnect());
        const reqId = nextRequestId();
        conn.sendRaw(
            NS_MEDIA,
            session.transportId,
            buildLoad({ sessionId: session.sessionId, contentId, contentType, streamType, currentTime, requestId: reqId })
        );
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const msg = await conn.waitFor(
                (m) =>
                    m.namespace === NS_MEDIA &&
                    (payloadOf(m).requestId === reqId || payloadOf(m).type === "MEDIA_STATUS"),
                Math.max(1000, deadline - Date.now())
            );
            if (!msg) break;
            const st = parseMediaStatus(payloadOf(msg));
            if (st && ["PLAYING", "BUFFERING", "PAUSED", "IDLE"].includes(st.playerState)) return { session, media: st };
        }
        throw new Error("Chromecast accepted LOAD but reported no media status (format may be unsupported)");
    } finally {
        await conn.close();
    }
}

/** Resolve the live DMR transport (fresh connection per command — no daemon). */
async function resolveDmrTransport(host, { port = CAST_PORT, timeoutMs = 8000 } = {}) {
    const apps = await castReceiverStatus(host, { port, timeoutMs });
    const session = findAppSession(apps, APP_DMR) || apps.find((a) => a.transportId && a.appId !== APP_BACKDROP);
    if (!session) throw new Error("Nothing playing on the Chromecast (Default Media Receiver is not running)");
    return { apps, session };
}

/** PAUSE / PLAY / STOP / SEEK-safe media command against the live session. */
export async function castMediaCommand(host, type, { port = CAST_PORT, timeoutMs = 10000 } = {}) {
    const { session } = await resolveDmrTransport(host, { port, timeoutMs });
    const conn = await openConnection(host, port, { timeoutMs });
    try {
        conn.sendRaw(NS_CONNECTION, session.transportId, buildConnect());
        const reqId = nextRequestId();
        conn.sendRaw(NS_MEDIA, session.transportId, buildMediaCommand(type, { requestId: reqId }));
        const msg = await conn.waitFor(
            (m) =>
                m.namespace === NS_MEDIA &&
                (payloadOf(m).requestId === reqId || payloadOf(m).type === "MEDIA_STATUS"),
            timeoutMs
        );
        return { session, media: msg ? parseMediaStatus(payloadOf(msg)) : null };
    } finally {
        await conn.close();
    }
}

/** Live media status for @cast-status (null when idle). */
export async function castMediaStatus(host, { port = CAST_PORT, timeoutMs = 8000 } = {}) {
    try {
        const { session } = await resolveDmrTransport(host, { port, timeoutMs });
        const conn = await openConnection(host, port, { timeoutMs });
        try {
            conn.sendRaw(NS_CONNECTION, session.transportId, buildConnect());
            const reqId = nextRequestId();
            conn.sendRaw(NS_MEDIA, session.transportId, { type: "GET_STATUS", requestId: reqId });
            const msg = await conn.waitFor(
                (m) => m.namespace === NS_MEDIA && payloadOf(m).type === "MEDIA_STATUS",
                timeoutMs
            );
            return { session, media: msg ? parseMediaStatus(payloadOf(msg)) : null };
        } finally {
            await conn.close();
        }
    } catch {
        return { session: null, media: null };
    }
}

/** Stop the running app session entirely (used by @cast-stop for media). */
export async function castStopApp(host, { port = CAST_PORT, timeoutMs = 10000 } = {}) {
    const apps = await castReceiverStatus(host, { port, timeoutMs });
    const session = findAppSession(apps, APP_DMR) || apps.find((a) => a.transportId && a.appId !== APP_BACKDROP);
    if (!session) return { stopped: false };
    const conn = await openConnection(host, port, { timeoutMs });
    try {
        conn.sendRaw(NS_RECEIVER, RECEIVER_ID, buildReceiverStop(session.sessionId));
        return { stopped: true, session };
    } finally {
        await conn.close();
    }
}
