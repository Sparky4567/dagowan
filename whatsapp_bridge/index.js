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

const activeJids = new Set();
let lastJid = "";

const status = {
  connection: "starting",
  lastError: "",
  qr: "",
  qrImage: "",
  pairingCode: "",
  phone: "",
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
  status.pairingCode = "";
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

async function askJarvis(text, remoteJid, audioFile = null) {
  const response = await fetch(PYTHON_CHAT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, source: "whatsapp", chat_id: remoteJid, audio_file: audioFile }),
    signal: AbortSignal.timeout(120000),
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || `JARVIS HTTP ${response.status}`);
  }
  return {
    reply: payload.reply || "",
    voice_reply: payload.voice_reply || null,
    transcribed_text: payload.transcribed_text || null,
    is_voice_input: payload.is_voice_input || false,
  };
}

const botSentMessageIds = new Set();

async function handleMessages(event) {
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

    if (!remoteJid || (!text && !audioFile)) {
      continue;
    }

    const isSelfMessage = message.key.fromMe === true;

    activeJids.add(remoteJid);
    lastJid = remoteJid;
    status.lastJid = remoteJid;
    status.activeJids = Array.from(activeJids);
    status.lastMessageAt = new Date().toISOString();

    console.log(`📱 WhatsApp ${isSelfMessage ? '[Self-Message]' : '[Incoming]'}: "${text || '[Voice Message]'}" from ${remoteJid}`);

    try {
      if (sock && typeof sock.sendPresenceUpdate === "function") {
        sock.sendPresenceUpdate("recording", remoteJid).catch(() => {});
      }
      const { reply, voice_reply, transcribed_text, is_voice_input } = await askJarvis(text, remoteJid, audioFile);

      if (is_voice_input && transcribed_text) {
        console.log(`🗣️ WhatsApp Voice Transcribed [from ${remoteJid}]: "${transcribed_text}"`);
        try {
          const sentTrans = await sock.sendMessage(remoteJid, { text: `🗣 [Voice Transcribed]: "${transcribed_text}"` });
          if (sentTrans && sentTrans.key && sentTrans.key.id) {
            botSentMessageIds.add(sentTrans.key.id);
          }
        } catch (tErr) {
          console.error("⚠️ Error sending WhatsApp transcribed text:", tErr.message);
        }
      }

      if (reply) {
        try {
          const sent = await sock.sendMessage(remoteJid, { text: reply });
          if (sent && sent.key && sent.key.id) {
            botSentMessageIds.add(sent.key.id);
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
            botSentMessageIds.add(sentVoice.key.id);
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
  sock.ev.on("connection.update", async (update) => {
    if (update.qr) {
      status.lastError = "";
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
                botSentMessageIds.add(sent.key.id);
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
            botSentMessageIds.add(sent.key.id);
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
  .listen(STATUS_PORT, "127.0.0.1");

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
