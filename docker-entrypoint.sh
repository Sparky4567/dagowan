#!/usr/bin/env bash
# Dagowan container entrypoint.
# - Ensures runtime directories exist
# - Maps well-known env vars into app_settings.json (only when set, never blanks existing values)
# - Re-applies the ONNX/Sharp compatibility patch (best effort)
# - Hands over to the Bun CLI: `bun run index.js "$@"`
set -e

cd /app

mkdir -p data backups logs tmp notes pdfs projects whatsapp_bridge/auth 2>/dev/null || true

# Persist root *.json state across container rebuilds.
# `dagowan-config` is mounted at /app/config-state (see compose / dockerize.sh).
# On boot, seed /app from the volume when /app is empty (fresh image) and
# seed the volume from /app when the volume is empty (first run with baked
# defaults). On shutdown (SIGTERM/SIGINT/EXIT), copy back so CLI edits
# (@set-*, @remember, sessions, tasks) survive `docker restart` / rebuilds.
STATE_DIR="/app/config-state"
STATE_FILES="app_settings.json characters.json memory.json chat_sessions.json tasks.json mcp_servers.json"
if [ -d "$STATE_DIR" ]; then
  for f in $STATE_FILES; do
    if [ -f "$STATE_DIR/$f" ] && [ ! -f "/app/$f" ]; then
      cp "$STATE_DIR/$f" "/app/$f" 2>/dev/null || true
    elif [ -f "/app/$f" ] && [ ! -f "$STATE_DIR/$f" ]; then
      cp "/app/$f" "$STATE_DIR/$f" 2>/dev/null || true
    fi
  done
  save_state() {
    for f in $STATE_FILES; do
      if [ -f "/app/$f" ]; then
        cp "/app/$f" "$STATE_DIR/$f" 2>/dev/null || true
      fi
    done
  }
  trap save_state EXIT HUP INT TERM
else
  save_state() { :; }
fi

# Map env -> app_settings.json without wiping user-tuned values stored in the volume.
if [ -n "${OLLAMA_HOST:-}" ] || [ -n "${OLLAMA_URL:-}" ] || [ -n "${OPENAI_API_KEY:-}" ] || [ -n "${GEMINI_API_KEY:-}" ] || [ -n "${CLAUDE_API_KEY:-}" ] || [ -n "${GROK_API_KEY:-}" ] || [ -n "${WHATSAPP_PHONE:-}" ] || [ -n "${WHATSAPP_ENABLED:-}" ] || [ -n "${WEB_ENABLED:-}" ] || [ -n "${DASHBOARD_ENABLED:-}" ] || [ -n "${DASHBOARD_PORT:-}" ] || [ -n "${WHATSAPP_QR_MODE:-}" ] || [ -n "${WHATSAPP_QR:-}" ] || [ -n "${TELEGRAM_TOKEN:-}" ] || [ -n "${NEEDLE_ENABLED:-}" ] || [ -n "${NEEDLE_MIN_CONFIDENCE:-}" ] || [ -n "${NEEDLE_MODEL_PATH:-}" ] || [ -n "${NEEDLE_PYTHON:-}" ] || [ -n "${NEEDLE_DAEMON_IDLE_MS:-}" ] || [ -n "${OPENCLI_ENABLED:-}" ] || [ -n "${OPENCLI_MODEL:-}" ] || [ -n "${OPENCLI_MAX_ITERATIONS:-}" ] || [ -n "${OPENCLI_ALLOWED_CHATS:-}" ] || [ -n "${CAST_DEVICE_NAME:-}" ] || [ -n "${CAST_DEVICE_HOST:-}" ] || [ -n "${CAST_DEVICE_TYPE:-}" ] || [ -n "${CAST_PORT:-}" ] || [ -n "${CAST_TRANSCODE:-}" ] || [ -n "${CAST_MAX_HEIGHT:-}" ]; then
  bun -e '
    const fs = require("node:fs");
    const p = "app_settings.json";
    let s = {};
    try { s = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
    const env = process.env;
    const ollama = env.OLLAMA_HOST || env.OLLAMA_URL || env.OLLAMA_BASE_URL;
    if (ollama) s.server_url = ollama;
    if (env.OPENAI_API_KEY) s.openai_api_key = env.OPENAI_API_KEY;
    if (env.GEMINI_API_KEY) s.gemini_api_key = env.GEMINI_API_KEY;
    if (env.CLAUDE_API_KEY) s.claude_api_key = env.CLAUDE_API_KEY;
    if (env.GROK_API_KEY) s.grok_api_key = env.GROK_API_KEY;
    if (env.WHATSAPP_PHONE) s.whatsapp_phone = env.WHATSAPP_PHONE;
    if (env.TELEGRAM_TOKEN) s.telegram_token = env.TELEGRAM_TOKEN;
    if (env.WHATSAPP_ENABLED === "0" || env.WHATSAPP_ENABLED === "false") s.whatsapp_enabled = false;
    if (env.WHATSAPP_ENABLED === "1" || env.WHATSAPP_ENABLED === "true") s.whatsapp_enabled = true;
    if (env.WEB_ENABLED === "0" || env.WEB_ENABLED === "false") { s.web_enabled = false; s.voice_server_enabled = false; }
    if (env.WEB_ENABLED === "1" || env.WEB_ENABLED === "true") { s.web_enabled = true; s.voice_server_enabled = true; }
    if (env.DASHBOARD_ENABLED === "0" || env.DASHBOARD_ENABLED === "false") s.dashboard_enabled = false;
    if (env.DASHBOARD_ENABLED === "1" || env.DASHBOARD_ENABLED === "true") s.dashboard_enabled = true;
    if (env.DASHBOARD_PORT) { const n = Number(env.DASHBOARD_PORT); if (Number.isFinite(n)) s.dashboard_port = n; }
    if (env.NEEDLE_ENABLED === "0" || env.NEEDLE_ENABLED === "false") s.needle_enabled = false;
    if (env.NEEDLE_ENABLED === "1" || env.NEEDLE_ENABLED === "true") s.needle_enabled = true;
    if (env.NEEDLE_MIN_CONFIDENCE) { const n = Number(env.NEEDLE_MIN_CONFIDENCE); if (Number.isFinite(n)) s.needle_min_confidence = n; }
    if (env.NEEDLE_MODEL_PATH) s.needle_model_path = env.NEEDLE_MODEL_PATH;
    if (env.NEEDLE_PYTHON) s.needle_python = env.NEEDLE_PYTHON;
    if (env.NEEDLE_DAEMON_IDLE_MS) { const n = Number(env.NEEDLE_DAEMON_IDLE_MS); if (Number.isFinite(n)) s.needle_daemon_idle_ms = n; }
    if (env.OPENCLI_ENABLED === "0" || env.OPENCLI_ENABLED === "false") s.opencli_enabled = false;
    if (env.OPENCLI_ENABLED === "1" || env.OPENCLI_ENABLED === "true") s.opencli_enabled = true;
    if (env.OPENCLI_MODEL) s.opencli_model = env.OPENCLI_MODEL;
    if (env.OPENCLI_MAX_ITERATIONS) { const n = Number(env.OPENCLI_MAX_ITERATIONS); if (Number.isFinite(n)) s.opencli_max_iterations = n; }
    if (env.OPENCLI_ALLOWED_CHATS) s.opencli_allowed_chats = String(env.OPENCLI_ALLOWED_CHATS).split(",").map((x) => x.trim()).filter(Boolean);
    if (env.CAST_DEVICE_NAME) s.cast_device_name = env.CAST_DEVICE_NAME;
    if (env.CAST_DEVICE_HOST) s.cast_device_host = env.CAST_DEVICE_HOST;
    if (env.CAST_DEVICE_TYPE) s.cast_device_type = env.CAST_DEVICE_TYPE;
    if (env.CAST_PORT) { const n = Number(env.CAST_PORT); if (Number.isFinite(n)) s.cast_port = n; }
    if (env.CAST_TRANSCODE) s.cast_transcode = env.CAST_TRANSCODE;
    if (env.CAST_MAX_HEIGHT) { const n = Number(env.CAST_MAX_HEIGHT); if (Number.isFinite(n)) s.cast_max_height = n; }
    fs.writeFileSync(p, JSON.stringify(s, null, 2));
    console.log("[entrypoint] app_settings.json synced from environment.");
  ' 2>/dev/null || echo "[entrypoint] warning: could not sync app_settings.json from env."
fi

# Keep node_modules patches fresh (matches starter.sh behaviour)
bun run patch_onnx.js >/dev/null 2>&1 || true

if [ "$#" -eq 0 ]; then
  # Default to the web UI only. WhatsApp is opt-in so an unconfigured
  # container never QR-spams: add --whatsapp only when explicitly enabled
  # (WHATSAPP_ENABLED=1/true) or a phone number is configured.
  set -- --web
  case "${WHATSAPP_ENABLED:-}" in
    1|true|TRUE|on|ON|enable|enabled|yes|YES) set -- "$@" --whatsapp ;;
    *)
      if [ -n "${WHATSAPP_PHONE:-}" ]; then
        set -- "$@" --whatsapp
      fi
      ;;
  esac
fi

echo "[entrypoint] Starting: bun run index.js $*"
exec bun run index.js "$@"
