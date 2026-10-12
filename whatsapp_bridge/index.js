const fs = require("fs");
const http = require("http");
const path = require("path");
const pino = require("pino");
const QRCode = require("qrcode");
const qrcode = require("qrcode-terminal");
const {
  default: makeWASocket,
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  downloadMediaMessage,
} = require("@whiskeysockets/baileys");

const PYTHON_CHAT_URL = process.env.JARVIS_CHAT_URL || "http://127.0.0.1:8765/chat";
const STATUS_PORT = Number(process.env.WHATSAPP_STATUS_PORT || 8766);
const AUTH_DIR = path.join(__dirname, "auth");

// Pairing UX:
// - Disabled by default unless WhatsApp is configured (phone number or an
//   existing auth session). The CLI gate in src/whatsapp.js enforces this;
//   the bridge re-enforces it so a bare `node index.js` never QR-spams.
// - WHATSAPP_QR_MODE: auto (default) | qr | pairing | off.
//   auto = QR on desktop, numeric pairing code on Termux (no camera scan
//   possible there). Explicit qr/pairing/off always win.
function isTermuxEnvironment(env = process.env) {
  if (env.TERMUX_VERSION) return true;
  if (String(env.PREFIX || "").includes("com.termux")) return true;
  return Object.keys(env || {}).some((k) => k.startsWith("TERMUX_"));
}
function getQrMode(env = process.env) {
  const raw = String(env.WHATSAPP_QR_MODE || env.WHATSAPP_QR || "auto").toLowerCase().trim();
  if (["off", "disable", "disabled", "none", "0", "false"].includes(raw)) return "off";
  if (["pairing", "pair", "numeric", "number", "code"].includes(raw)) return "pairing";
  if (["qr", "qrcode", "scan"].includes(raw)) return "qr";
  return "auto";
}
function sanitizePhone(value) {
  return String(value || "").replace(/[^0-9]/g, "");
}
function configuredPhone() {
  return sanitizePhone(process.env.WHATSAPP_PHONE);
}
function hasAuthSession() {
  try {
    return fs.existsSync(path.join(AUTH_DIR, "creds.json"));
  } catch (_) {
    return false;
  }
}
function shouldEmitQr() {
  const mode = getQrMode();
  if (mode === "off" || mode === "pairing") return false;
  if (mode === "qr") return true;
  // auto: Termux cannot scan a QR with its own camera -> numeric codes only.
  if (isTermuxEnvironment()) return false;
  return true;
}
const IS_TERMUX = isTermuxEnvironment();

// Group @character-name callout gate: in group chats (@g.us) each persona
// responds only when explicitly mentioned (e.g. "@Parsly ...").
// Set WHATSAPP_MENTION_ONLY_GROUPS=0 to restore reply-to-everything in groups.
// "@" bot commands (@help, @make, ...) always bypass the gate. 1:1 DMs always
// reply (as the mentioned persona when tagged, else as the active character).
const { findMentionedCharacters, isGroupJid, isWhatsAppCommandText } = require("./mentions");
const MENTION_ONLY_GROUPS = (() => {
  const env = process.env.WHATSAPP_MENTION_ONLY_GROUPS;
  if (env === "0" || (env && env.toLowerCase() === "false")) return false;
  return true;
})();

const CHARACTERS_FILE = path.join(__dirname, "..", "characters.json");
let cachedCharacters = null;
let cachedCharactersMtime = 0;
function loadBridgeCharacters() {
  try {
    const stat = fs.statSync(CHARACTERS_FILE);
    const mtime = stat.mtimeMs;
    if (cachedCharacters && mtime === cachedCharactersMtime) return cachedCharacters;
    const raw = fs.readFileSync(CHARACTERS_FILE, "utf8");
    const data = JSON.parse(raw);
    cachedCharacters = Array.isArray(data.characters) ? data.characters : [];
    cachedCharactersMtime = mtime;
    return cachedCharacters;
  } catch (_) {
    return cachedCharacters || [];
  }
}

const activeJids = new Set();
let lastJid = "";

const status = {
  connection: "starting",
  lastError: "",
  qr: "",
  qrImage: "",
  pairingCode: "",
  pairingPhone: "",
  qrMode: getQrMode(),
  termux: IS_TERMUX,
  phone: "",
  phoneConfigured: Boolean(configuredPhone()),
  lastMessageAt: "",
  lastJid: "",
  activeJids: [],
};

let sock = null;
let reconnectTimer = null;
let statusServer = null;
let hasLoggedOpenSuccess = false;

const LOGS_DIR = path.join(__dirname, "..", "logs");
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

function setError(error) {
  const msg = error && error.message ? error.message : String(error || "");
  status.lastError = msg;
  try {
    fs.appendFileSync(path.join(LOGS_DIR, "error.log"), `[${new Date().toISOString()}] [WHATSAPP_BRIDGE] ${msg}\n`);
  } catch (_) {}
}

function clearQr() {
  status.qr = "";
  status.qrImage = "";
  if (!status.pairingCode) status.pairingCode = "";
}

async function ensurePairingCode(phone) {
  const digits = sanitizePhone(phone || configuredPhone());
  if (!digits || digits.length < 7) {
    throw new Error("phone number with country code is required (e.g. 37060000000)");
  }
  if (!sock || typeof sock.requestPairingCode !== "function") {
    throw new Error("WhatsApp socket is not ready yet, retry in a few seconds");
  }
  if (sock.user && sock.user.id) {
    throw new Error("already linked — no pairing code needed");
  }
  const code = await sock.requestPairingCode(digits);
  status.pairingCode = String(code || "").replace(/[^0-9A-Za-z-]/g, "") || String(code || "");
  status.pairingPhone = digits;
  status.phoneConfigured = true;
  return status.pairingCode;
}

function logPairingCode(code, phone) {
  console.log("\n=======================================================");
  console.log(`📱 WHATSAPP PAIRING CODE for +${phone}: ${code}`);
  console.log("1. Open WhatsApp on phone → Linked Devices → Link a Device");
  console.log('2. Tap "Link with phone number instead"');
  console.log(`3. Enter Code: ${code}`);
  console.log("=======================================================\n");
}

function clearLinkedAccount() {
  status.phone = "";
}

function renderMicroQR(qrData) {
  try {
    const qr = QRCode.create(qrData, { errorCorrectionLevel: "L" });
    const size = qr.modules.size;
    const data = qr.modules.data;
    let out = "";
    out += "█".repeat(size + 2) + "\n";
    for (let y = 0; y < size; y += 2) {
      out += "█";
      for (let x = 0; x < size; x++) {
        const top = data[y * size + x];
        const bottom = (y + 1 < size) ? data[(y + 1) * size + x] : 0;
        if (!top && !bottom) out += "█";
        else if (!top && bottom) out += "▀";
        else if (top && !bottom) out += "▄";
        else out += " ";
      }
      out += "█\n";
    }
    out += "█".repeat(size + 2) + "\n";
    return out;
  } catch (_) {
    return null;
  }
}

function unwrapMessage(msg) {
  if (!msg) return {};
  if (msg.ephemeralMessage && msg.ephemeralMessage.message) {
    return unwrapMessage(msg.ephemeralMessage.message);
  }
  if (msg.viewOnceMessage && msg.viewOnceMessage.message) {
    return unwrapMessage(msg.viewOnceMessage.message);
  }
  if (msg.viewOnceMessageV2 && msg.viewOnceMessageV2.message) {
    return unwrapMessage(msg.viewOnceMessageV2.message);
  }
  if (msg.documentWithCaptionMessage && msg.documentWithCaptionMessage.message) {
    return unwrapMessage(msg.documentWithCaptionMessage.message);
  }
  return msg;
}

function isAudioPayload(payload) {
  if (!payload) return false;
  if (payload.audioMessage || payload.pttMessage) return true;
  if (payload.documentMessage) {
    const mime = (payload.documentMessage.mimetype || "").toLowerCase();
    const fileName = (payload.documentMessage.fileName || "").toLowerCase();
    if (mime.startsWith("audio/") || /\.(ogg|opus|mp3|wav|m4a|aac|flac|wma|amr)$/i.test(fileName)) {
      return true;
    }
  }
  return false;
}

function readTextMessage(message) {
  const payload = unwrapMessage(message.message || {});
  if (payload.conversation) {
    return payload.conversation;
  }
  if (payload.extendedTextMessage && payload.extendedTextMessage.text) {
    return payload.extendedTextMessage.text;
  }
  if (payload.imageMessage && payload.imageMessage.caption) {
    return payload.imageMessage.caption;
  }
  if (payload.videoMessage && payload.videoMessage.caption) {
    return payload.videoMessage.caption;
  }
  if (payload.documentMessage && payload.documentMessage.caption) {
    return payload.documentMessage.caption;
  }
  return "";
}

async function askJarvis(text, remoteJid, audioFile = null, isGroup = false) {
  const headers = { "Content-Type": "application/json" };
  // Optional shared secret (WHATSAPP_BRIDGE_TOKEN on both processes).
  // Unset = open loopback trust, as before.
  if (process.env.WHATSAPP_BRIDGE_TOKEN) {
    headers["x-bridge-token"] = process.env.WHATSAPP_BRIDGE_TOKEN;
  }
  const response = await fetch(PYTHON_CHAT_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ text, source: "whatsapp", chat_id: remoteJid, audio_file: audioFile, is_group: isGroup }),
    signal: AbortSignal.timeout(120000),
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || `JARVIS HTTP ${response.status}`);
  }
  return {
    reply: payload.reply || "",
    silent: payload.silent === true,
    voice_reply: payload.voice_reply || null,
    transcribed_text: payload.transcribed_text || null,
    is_voice_input: payload.is_voice_input || false,
  };
}

const botSentMessageIds = new Set();

// Baileys re-emits messages (reconnect/history sync, multi-device fan-out),
// and `messages.upsert` fires per sync batch — not per new message. Without
// dedup, one WhatsApp message = N concurrent LLM round-trips + N replies.
// Bounded LRU-ish set (insertion-ordered Set, evict oldest past cap).
const seenIncomingIds = new Set();
function trackBounded(set, id, cap = 2000) {
    set.add(id);
    if (set.size > cap) {
        const oldest = set.values().next().value;
        set.delete(oldest);
    }
}

async function handleMessages(event) {
  // Only live deliveries. "append" batches are history syncs — answering
  // those replays months-old chatter through the LLM on every reconnect.
  if (event && typeof event.type === "string" && event.type !== "notify") {
    return;
  }
  for (const message of event.messages || []) {
    const msgId = message.key && message.key.id;
    if (msgId && botSentMessageIds.has(msgId)) {
      botSentMessageIds.delete(msgId);
      continue;
    }
    if (!message.message) {
      continue;
    }
    const unwrapped = unwrapMessage(message.message);
    const remoteJid = message.key.remoteJid;
    // Status-view updates are not chats; answering them spams the LLM and
    // can leak replies into the status thread.
    if (!remoteJid || remoteJid === "status@broadcast") {
      continue;
    }
    // Drop redeliveries of an already-seen stanza (same chat + sender + id).
    const dedupKey = msgId ? `${remoteJid}::${message.key.participant || ""}::${msgId}` : null;
    if (dedupKey) {
      if (seenIncomingIds.has(dedupKey)) {
        continue;
      }
      trackBounded(seenIncomingIds, dedupKey);
    }
    const isAudio = isAudioPayload(unwrapped);
    let text = readTextMessage(message).trim();
    let audioFile = null;

    if (isAudio) {
      try {
        const downloadPromise = downloadMediaMessage(message, "buffer", {});
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Media download timed out after 30s")), 30000)
        );
        const buffer = await Promise.race([downloadPromise, timeoutPromise]);
        const tmpDir = path.join(__dirname, "..", "tmp");
        if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
        audioFile = path.join(tmpDir, `wa_voice_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.ogg`);
        fs.writeFileSync(audioFile, buffer);
      } catch (err) {
        console.error("⚠️ Error downloading WhatsApp audio:", err.message);
      }
    }

    if (remoteJid && (!text && !audioFile)) {
      continue;
    }

    const isSelfMessage = message.key.fromMe === true;
    const isGroup = isGroupJid(remoteJid);

    trackBounded(activeJids, remoteJid, 500);
    lastJid = remoteJid;
    status.lastJid = remoteJid;
    status.activeJids = Array.from(activeJids);
    status.lastMessageAt = new Date().toISOString();

    console.log(`📱 WhatsApp ${isSelfMessage ? '[Self-Message]' : '[Incoming]'}: "${text || '[Voice Message]'}" from ${remoteJid}`);

    // Cheap pre-filter: in groups without an @character-name mention (and not
    // a "@" bot command or a voice note needing transcription), stay silent
    // without paying for an HTTP + LLM round-trip. The server in
    // src/whatsapp.js re-checks authoritatively, including transcribed audio.
    if (isGroup && MENTION_ONLY_GROUPS && !isAudio && text && !isWhatsAppCommandText(text)) {
      const mentioned = findMentionedCharacters(text, loadBridgeCharacters());
      if (mentioned.length === 0) {
        console.log(`📱 WhatsApp [Group Ignored]: no @character-name mention in message from ${remoteJid}`);
        continue;
      }
      console.log(`📱 WhatsApp [Group Callout]: ${mentioned.map((c) => `@${c.name}`).join(", ")} mentioned in ${remoteJid}`);
    }

    try {
      if (sock && typeof sock.sendPresenceUpdate === "function") {
        sock.sendPresenceUpdate("recording", remoteJid).catch(() => {});
      }
      const { reply, silent, voice_reply, transcribed_text, is_voice_input } = await askJarvis(text, remoteJid, audioFile, isGroup);

      if (silent) {
        console.log(`📱 WhatsApp [Group Ignored]: server stayed silent (no @character-name mention) for ${remoteJid}`);
        continue;
      }

      if (is_voice_input && transcribed_text) {
        console.log(`🗣️ WhatsApp Voice Transcribed [from ${remoteJid}]: "${transcribed_text}"`);
        try {
          const sentTrans = await sock.sendMessage(remoteJid, { text: `🗣 [Voice Transcribed]: "${transcribed_text}"` });
          if (sentTrans && sentTrans.key && sentTrans.key.id) {
            trackBounded(botSentMessageIds, sentTrans.key.id);
          }
        } catch (tErr) {
          console.error("⚠️ Error sending WhatsApp transcribed text:", tErr.message);
        }
      }

      if (reply) {
        try {
          const sent = await sock.sendMessage(remoteJid, { text: reply });
          if (sent && sent.key && sent.key.id) {
            trackBounded(botSentMessageIds, sent.key.id);
          }
        } catch (mErr) {
          console.error("⚠️ Error sending WhatsApp text reply:", mErr.message);
        }
      }

      if (voice_reply && fs.existsSync(voice_reply)) {
        try {
          const sentVoice = await sock.sendMessage(remoteJid, {
            audio: { url: voice_reply },
            mimetype: "audio/ogg; codecs=opus",
            ptt: true,
          });
          if (sentVoice && sentVoice.key && sentVoice.key.id) {
            trackBounded(botSentMessageIds, sentVoice.key.id);
          }
        } catch (vErr) {
          console.error("⚠️ Error sending WhatsApp voice note:", vErr.message);
        } finally {
          try { fs.unlinkSync(voice_reply); } catch (_) {}
        }
      }
    } catch (error) {
      setError(error);
      console.error("⚠️ Error processing WhatsApp message:", error.message);
    } finally {
      if (sock && typeof sock.sendPresenceUpdate === "function") {
        sock.sendPresenceUpdate("paused", remoteJid).catch(() => {});
      }
    }
  }
}

function scheduleReconnect() {
  if (reconnectTimer) {
    return;
  }
  status.connection = "reconnecting";
  clearQr();
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    start().catch(setError);
  }, 3000);
}

async function start() {
  if (sock) {
    try {
      sock.end(undefined);
    } catch (_) {
    }
    sock = null;
  }

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  sock = makeWASocket({
    auth: state,
    logger: pino({ level: "silent" }),
    browser: Browsers.ubuntu("JARVIS_CORE"),
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 60_000,
    markOnlineOnConnect: false,
    printQRInTerminal: false,
    version,
  });

  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("messages.upsert", handleMessages);
  // Numeric-code-first flow: when a phone number is configured and this
  // device is not registered yet, fetch the 8-digit pairing code right away
  // (required on Termux where QR scanning is impossible). Failures are
  // non-fatal — the QR / /pair endpoint remain available.
  try {
    const { creds } = state || {};
    const phone = configuredPhone();
    if (phone && !creds?.registered && typeof sock.requestPairingCode === "function") {
      // Small delay: pairing immediately on a fresh socket can race the
      // websocket handshake on slow networks.
      setTimeout(async () => {
        try {
          if (sock && !(sock.user && sock.user.id)) {
            const code = await ensurePairingCode(phone);
            logPairingCode(code, phone);
          }
        } catch (err) {
          console.log(`📱 Pairing code not ready yet: ${err.message} (retry via POST /pair or @whatsapp-pair)`);
        }
      }, 3000);
    } else if (!phone && !hasAuthSession()) {
      const mode = getQrMode();
      if (mode === "auto" && IS_TERMUX) {
        console.log("📱 WhatsApp not configured: set WHATSAPP_PHONE and use the numeric pairing code (Termux cannot scan QR codes).");
        console.log("   Example: WHATSAPP_PHONE=37060000000 node index.js   or   POST /pair {\"phone\": \"37060000000\"}");
      } else if (mode !== "off") {
        console.log("📱 WhatsApp not configured: scan the QR code to link, or set WHATSAPP_PHONE for a numeric pairing code.");
      }
    }
  } catch (_) {}
  sock.ev.on("connection.update", async (update) => {
    if (update.qr) {
      status.lastError = "";
      if (!shouldEmitQr()) {
        // Termux auto mode / pairing / off: keep the raw payload available
        // via /status for the web view, but do not flood the terminal with
        // an unscannable QR. Nudge toward the numeric code instead.
        status.qr = update.qr;
        status.qrImage = await QRCode.toDataURL(update.qr).catch(() => "");
        if (getQrMode() !== "off" && !configuredPhone()) {
          console.log("📱 QR suppressed (Termux auto mode): set WHATSAPP_PHONE to get a numeric pairing code, or POST /pair {\"phone\": \"...\"}.");
        }
        return;
      }
      status.qr = update.qr;
      status.qrImage = await QRCode.toDataURL(update.qr);
      console.log("\n=======================================================");
      console.log("📱 SCAN WHATSAPP QR CODE BELOW WITH PHONE CAMERA:");
      console.log("=======================================================\n");
      const micro = renderMicroQR(update.qr);
      if (micro) {
        console.log(micro);
      } else {
        qrcode.generate(update.qr, { small: true });
      }
    }
    if (update.connection) {
      status.connection = update.connection;
      if (update.connection === "open") {
        status.lastError = "";
        clearQr();
        if (!hasLoggedOpenSuccess) {
          hasLoggedOpenSuccess = true;
          console.log("\n=======================================================");
          console.log("✅ WhatsApp Connection OPEN and Authenticated Successfully!");
          console.log("=======================================================\n");
        }
      } else if (update.connection === "close") {
        hasLoggedOpenSuccess = false;
        if (update.lastDisconnect) {
          setError(update.lastDisconnect.error || "");
          const code = update.lastDisconnect.error &&
            update.lastDisconnect.error.output &&
            update.lastDisconnect.error.output.statusCode;
          if (code === DisconnectReason.loggedOut) {
            clearQr();
            clearLinkedAccount();
          } else {
            scheduleReconnect();
          }
        } else {
          scheduleReconnect();
        }
      }
    }
    if (sock.user && sock.user.id) {
      status.phone = sock.user.id;
      clearQr();
    }
  });
}

statusServer = http
  .createServer((req, res) => {
    if (req.method === "GET" && req.url === "/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(status));
      return;
    }
    if (req.method === "POST" && req.url === "/send") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", async () => {
        try {
          const payload = JSON.parse(body || "{}");
          const jid = payload.jid || payload.chat_id || status.lastJid;
          const text = payload.text;
          if (!sock || status.connection !== "open") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "WhatsApp connection is not open" }));
            return;
          }
          if (payload.broadcast) {
            const targets = payload.jids || status.activeJids;
            for (const targetJid of targets) {
              const sent = await sock.sendMessage(targetJid, { text });
              if (sent && sent.key && sent.key.id) {
                trackBounded(botSentMessageIds, sent.key.id);
              }
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, sent_to: targets }));
            return;
          }
          if (!jid || !text) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "jid and text are required" }));
            return;
          }
          const sent = await sock.sendMessage(jid, { text });
          if (sent && sent.key && sent.key.id) {
            trackBounded(botSentMessageIds, sent.key.id);
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: String(err.message || err) }));
        }
      });
      return;
    }
    if (req.method === "GET" && (req.url === "/health" || req.url === "/healthz")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, status: status.connection }));
      return;
    }
    if (req.method === "GET" && (req.url === "/qr" || req.url === "/" || req.url === "/pair")) {
      // Serve the pairing web view when present, else JSON fallback.
      const htmlPath = path.join(__dirname, "..", "whatsapp_qr.html");
      try {
        if (fs.existsSync(htmlPath)) {
          const html = fs.readFileSync(htmlPath, "utf8");
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(html);
          return;
        }
      } catch (_) {}
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, connection: status.connection, qr: status.qr, pairingCode: status.pairingCode }));
      return;
    }
    if (req.method === "POST" && req.url === "/pair") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", async () => {
        try {
          const payload = JSON.parse(body || "{}");
          const phone = sanitizePhone(payload.phone || payload.phoneNumber || configuredPhone());
          if (!phone || phone.length < 7) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "phone with country code is required, e.g. {\"phone\": \"37060000000\"}" }));
            return;
          }
          try {
            const code = await ensurePairingCode(phone);
            logPairingCode(code, phone);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, pairingCode: code, phone }));
          } catch (err) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: String(err.message || err) }));
          }
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: String(err.message || err) }));
        }
      });
      return;
    }
    if ((req.method === "POST" && (req.url === "/reset" || req.url === "/logout")) || (req.method === "GET" && req.url === "/reset")) {
      try {
        if (fs.existsSync(AUTH_DIR)) {
          for (const file of fs.readdirSync(AUTH_DIR)) {
            try { fs.unlinkSync(path.join(AUTH_DIR, file)); } catch (_) {}
          }
        }
        clearQr();
        status.pairingPhone = "";
        clearLinkedAccount();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, message: "auth cleared, reconnecting for a fresh QR/pairing code" }));
        scheduleReconnect();
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(err.message || err) }));
      }
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false }));
  })
  .on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      console.log(`📱 WhatsApp status server port ${STATUS_PORT} is already active. Exiting duplicate instance.`);
      process.exit(0);
    }
    status.connection = "error";
    setError(error);
    console.error(error);
  })
  .listen(STATUS_PORT, "0.0.0.0");

process.on("unhandledRejection", (err) => {
  const msg = (err && (err.message || (err.output && err.output.payload && err.output.payload.message))) || String(err || "");
  if (msg.includes("Connection Closed") || msg.includes("Precondition Required") || msg.includes("428")) {
    console.log("📱 WhatsApp connection transiently closed. Auto-reconnecting...");
    scheduleReconnect();
  } else {
    console.error("⚠️ Unhandled WhatsApp Rejection:", msg);
  }
});

process.on("uncaughtException", (err) => {
  const msg = (err && (err.message || (err.output && err.output.payload && err.output.payload.message))) || String(err || "");
  if (msg.includes("Connection Closed") || msg.includes("Precondition Required") || msg.includes("428")) {
    console.log("📱 WhatsApp connection transiently closed. Auto-reconnecting...");
    scheduleReconnect();
  } else {
    console.error("⚠️ Uncaught WhatsApp Exception:", msg);
  }
});

start().catch((error) => {
  status.connection = "error";
  setError(error);
  scheduleReconnect();
});
