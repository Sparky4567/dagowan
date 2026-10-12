// Popup: WebSocket client for the Dagowan voice bridge (ws://127.0.0.1:8767/ws).
// Protocol (src/voice_socket.js): send {event:"text_prompt",text}, receive
// {event:"stt_transcript"|"llm_complete"|"state_change"|"tts_audio"|"settings_updated"|"connected"}.
const DEFAULT_WS = "ws://127.0.0.1:8767/ws";
let ws = null;

const $ = (id) => document.getElementById(id);
const log = $("log"), lockBadge = $("lockBadge"), promptInput = $("promptInput");

function addMsg(cls, text) {
  const d = document.createElement("div");
  d.className = "msg " + cls;
  d.innerText = text;
  log.appendChild(d);
  log.scrollTop = log.scrollHeight;
}

function setLock(text) { lockBadge.innerText = text; }

function inferLock(reply) {
  const t = String(reply || "");
  if (/🔓 Unlocked|OTP accepted|enrolled \+ authenticated/i.test(t)) setLock("🔓 unlocked");
  // "This surface: unlocked" must win over the generic locked patterns
  // below: "unlocked" contains the substring "locked".
  else if (/This surface: unlocked/i.test(t)) setLock("🔓 unlocked");
  else if (/Security PIN: set/i.test(t)) setLock("🔒 locked");
  else if (/🔒.*locked|🔐.*(required|NOT authenticated|enrolled but NOT)|⛔ Wrong|still locked/i.test(t)) setLock("🔒 locked");
  else if (/Security PIN: not set/i.test(t) && /OTP: not enrolled/i.test(t)) setLock("🔓 open");
}

async function getWsUrl() {
  const o = await chrome.storage.sync.get({ wsUrl: DEFAULT_WS });
  return o.wsUrl || DEFAULT_WS;
}

function connect() {
  getWsUrl().then((url) => {
    $("srvLabel").innerText = url.replace(/^ws:\/\//, "").replace(/\/ws$/, "");
    $("serverInput").placeholder = url;
    try { if (ws) ws.close(); } catch (_) {}
    ws = new WebSocket(url);
    ws.onopen = () => {
      addMsg("bot", "✅ Connected to " + url);
      send("@security-status", true);
      send("@otp-status", true);
    };
    ws.onmessage = (ev) => {
      try {
        const d = JSON.parse(ev.data);
        if (d.event === "llm_complete") { addMsg("bot", d.text); inferLock(d.text); }
        else if (d.event === "stt_transcript") { /* echoed by server; popup already shows user text */ }
        else if (d.event === "connected" && d.settings) { /* ignore */ }
      } catch (e) { console.warn(e); }
    };
    ws.onclose = () => addMsg("bot", "⚠️ Disconnected. Hit 🔄 to reconnect (is --web running?)");
    ws.onerror = () => addMsg("bot", "⚠️ Socket error — check the server URL and that ./starter.sh --web is running.");
  });
}

function send(text, silent) {
  if (!text) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) { addMsg("bot", "⚠️ Not connected. Hit 🔄 first."); return; }
  if (!silent) addMsg("user", text);
  ws.send(JSON.stringify({ event: "text_prompt", text }));
}

$("sendBtn").addEventListener("click", () => { send(promptInput.value.trim()); promptInput.value = ""; });
promptInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { send(promptInput.value.trim()); promptInput.value = ""; } });
$("connBtn").addEventListener("click", connect);
$("saveSrv").addEventListener("click", async () => {
  const v = $("serverInput").value.trim();
  if (v) { await chrome.storage.sync.set({ wsUrl: v }); connect(); }
});
$("unlockBtn").addEventListener("click", () => {
  const pin = $("pinInput").value.trim();
  send(pin ? `@unlock ${pin}` : "@unlock");
});
$("otpBtn").addEventListener("click", () => {
  const code = $("otpInput").value.trim();
  send(code ? `@otp-login ${code}` : "@otp-login");
});
document.querySelectorAll("[data-cmd]").forEach((b) =>
  b.addEventListener("click", () => send(b.getAttribute("data-cmd")))
);

// Incoming selection from context menu / content script.
chrome.storage.local.get({ pendingPrompt: "" }, (o) => {
  if (o.pendingPrompt) {
    chrome.storage.local.set({ pendingPrompt: "" });
    promptInput.value = o.pendingPrompt;
    // Wait for socket before auto-sending.
    const iv = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) { clearInterval(iv); send(promptInput.value.trim()); promptInput.value = ""; }
    }, 300);
    setTimeout(() => clearInterval(iv), 5000);
  }
});

connect();
