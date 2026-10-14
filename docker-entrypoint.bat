@echo off
REM ==============================================================================
REM Dagowan container entrypoint. Windows port of docker-entrypoint.sh.
REM NOTE: Linux containers still use docker-entrypoint.sh; this .bat is the
REM equivalent logic for Windows-based runs / reference.
REM - Ensures runtime directories exist
REM - Maps well-known env vars into app_settings.json (only when set)
REM - Re-applies the ONNX/Sharp compatibility patch (best effort)
REM - Hands over to the Bun CLI: bun run index.js %*
REM ==============================================================================
setlocal EnableDelayedExpansion
cd /d "C:\app" 2>nul
if errorlevel 1 cd /d "%~dp0"

if not exist data mkdir data
if not exist backups mkdir backups
if not exist logs mkdir logs
if not exist tmp mkdir tmp
if not exist notes mkdir notes
if not exist pdfs mkdir pdfs
if not exist projects mkdir projects
if not exist whatsapp_bridge\auth mkdir whatsapp_bridge\auth

REM Persist root *.json state across container rebuilds (dagowan-config volume).
set "STATE_DIR=\app\config-state"
if not exist "%STATE_DIR%" set "STATE_DIR=config-state"
set "STATE_FILES=app_settings.json characters.json memory.json chat_sessions.json tasks.json mcp_servers.json"
if exist "%STATE_DIR%" (
  for %%F in (%STATE_FILES%) do (
    if exist "%STATE_DIR%\%%F" (
      if not exist "%%F" copy /y "%STATE_DIR%\%%F" "%%F" >nul 2>&1
    ) else (
      if exist "%%F" copy /y "%%F" "%STATE_DIR%\%%F" >nul 2>&1
    )
  )
)

REM Map env -> app_settings.json without wiping user-tuned values.
REM (Same field list as docker-entrypoint.sh; runs only when at least one knob is set.)
set "HAS_ENV="
if defined OLLAMA_HOST set "HAS_ENV=1"
if defined OLLAMA_URL set "HAS_ENV=1"
if defined OPENAI_API_KEY set "HAS_ENV=1"
if defined GEMINI_API_KEY set "HAS_ENV=1"
if defined CLAUDE_API_KEY set "HAS_ENV=1"
if defined GROK_API_KEY set "HAS_ENV=1"
if defined MISTRAL_API_KEY set "HAS_ENV=1"
if defined WHATSAPP_PHONE set "HAS_ENV=1"
if defined WHATSAPP_ENABLED set "HAS_ENV=1"
if defined WEB_ENABLED set "HAS_ENV=1"
if defined WHATSAPP_QR_MODE set "HAS_ENV=1"
if defined WHATSAPP_QR set "HAS_ENV=1"
if defined TELEGRAM_TOKEN set "HAS_ENV=1"
if defined NEEDLE_ENABLED set "HAS_ENV=1"
if defined NEEDLE_MIN_CONFIDENCE set "HAS_ENV=1"
if defined NEEDLE_MODEL_PATH set "HAS_ENV=1"
if defined NEEDLE_PYTHON set "HAS_ENV=1"
if defined NEEDLE_DAEMON_IDLE_MS set "HAS_ENV=1"
if defined OPENCLI_ENABLED set "HAS_ENV=1"
if defined OPENCLI_MODEL set "HAS_ENV=1"
if defined OPENCLI_MAX_ITERATIONS set "HAS_ENV=1"
if defined OPENCLI_ALLOWED_CHATS set "HAS_ENV=1"
if defined CAST_DEVICE_NAME set "HAS_ENV=1"
if defined CAST_DEVICE_HOST set "HAS_ENV=1"
if defined CAST_DEVICE_TYPE set "HAS_ENV=1"
if defined CAST_PORT set "HAS_ENV=1"
if defined CAST_TRANSCODE set "HAS_ENV=1"
if defined CAST_MAX_HEIGHT set "HAS_ENV=1"

if defined HAS_ENV (
  bun -e "const fs = require('node:fs'); const p = 'app_settings.json'; let s = {}; try { s = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) {} const env = process.env; const ollama = env.OLLAMA_HOST || env.OLLAMA_URL || env.OLLAMA_BASE_URL; if (ollama) s.server_url = ollama; if (env.OPENAI_API_KEY) s.openai_api_key = env.OPENAI_API_KEY; if (env.GEMINI_API_KEY) s.gemini_api_key = env.GEMINI_API_KEY; if (env.CLAUDE_API_KEY) s.claude_api_key = env.CLAUDE_API_KEY; if (env.GROK_API_KEY) s.grok_api_key = env.GROK_API_KEY; if (env.MISTRAL_API_KEY) s.mistral_api_key = env.MISTRAL_API_KEY; if (env.WHATSAPP_PHONE) s.whatsapp_phone = env.WHATSAPP_PHONE; if (env.TELEGRAM_TOKEN) s.telegram_token = env.TELEGRAM_TOKEN; if (env.WHATSAPP_ENABLED === '0' || env.WHATSAPP_ENABLED === 'false') s.whatsapp_enabled = false; if (env.WHATSAPP_ENABLED === '1' || env.WHATSAPP_ENABLED === 'true') s.whatsapp_enabled = true; if (env.WEB_ENABLED === '0' || env.WEB_ENABLED === 'false') { s.web_enabled = false; s.voice_server_enabled = false; } if (env.WEB_ENABLED === '1' || env.WEB_ENABLED === 'true') { s.web_enabled = true; s.voice_server_enabled = true; } if (env.NEEDLE_ENABLED === '0' || env.NEEDLE_ENABLED === 'false') s.needle_enabled = false; if (env.NEEDLE_ENABLED === '1' || env.NEEDLE_ENABLED === 'true') s.needle_enabled = true; if (env.NEEDLE_MIN_CONFIDENCE) { const n = Number(env.NEEDLE_MIN_CONFIDENCE); if (Number.isFinite(n)) s.needle_min_confidence = n; } if (env.NEEDLE_MODEL_PATH) s.needle_model_path = env.NEEDLE_MODEL_PATH; if (env.NEEDLE_PYTHON) s.needle_python = env.NEEDLE_PYTHON; if (env.NEEDLE_DAEMON_IDLE_MS) { const n = Number(env.NEEDLE_DAEMON_IDLE_MS); if (Number.isFinite(n)) s.needle_daemon_idle_ms = n; } if (env.OPENCLI_ENABLED === '0' || env.OPENCLI_ENABLED === 'false') s.opencli_enabled = false; if (env.OPENCLI_ENABLED === '1' || env.OPENCLI_ENABLED === 'true') s.opencli_enabled = true; if (env.OPENCLI_MODEL) s.opencli_model = env.OPENCLI_MODEL; if (env.OPENCLI_MAX_ITERATIONS) { const n = Number(env.OPENCLI_MAX_ITERATIONS); if (Number.isFinite(n)) s.opencli_max_iterations = n; } if (env.OPENCLI_ALLOWED_CHATS) s.opencli_allowed_chats = String(env.OPENCLI_ALLOWED_CHATS).split(',').map((x) => x.trim()).filter(Boolean); if (env.CAST_DEVICE_NAME) s.cast_device_name = env.CAST_DEVICE_NAME; if (env.CAST_DEVICE_HOST) s.cast_device_host = env.CAST_DEVICE_HOST; if (env.CAST_DEVICE_TYPE) s.cast_device_type = env.CAST_DEVICE_TYPE; if (env.CAST_PORT) { const n = Number(env.CAST_PORT); if (Number.isFinite(n)) s.cast_port = n; } if (env.CAST_TRANSCODE) s.cast_transcode = env.CAST_TRANSCODE; if (env.CAST_MAX_HEIGHT) { const n = Number(env.CAST_MAX_HEIGHT); if (Number.isFinite(n)) s.cast_max_height = n; } fs.writeFileSync(p, JSON.stringify(s, null, 2)); console.log('[entrypoint] app_settings.json synced from environment.');"
  if errorlevel 1 echo [entrypoint] warning: could not sync app_settings.json from env.
)

REM Keep node_modules patches fresh (matches starter.bat behaviour)
bun run patch_onnx.js >nul 2>&1

REM Default to the web UI only; add --whatsapp only when explicitly enabled.
set "ARGS=%*"
if "%ARGS%"=="" (
  set "ARGS=--web"
  if /i "%WHATSAPP_ENABLED%"=="1" set "ARGS=--web --whatsapp"
  if /i "%WHATSAPP_ENABLED%"=="true" set "ARGS=--web --whatsapp"
  if /i "%WHATSAPP_ENABLED%"=="on" set "ARGS=--web --whatsapp"
  if /i "%WHATSAPP_ENABLED%"=="enable" set "ARGS=--web --whatsapp"
  if /i "%WHATSAPP_ENABLED%"=="enabled" set "ARGS=--web --whatsapp"
  if /i "%WHATSAPP_ENABLED%"=="yes" set "ARGS=--web --whatsapp"
  if not defined WHATSAPP_ENABLED (
    if defined WHATSAPP_PHONE set "ARGS=--web --whatsapp"
  )
  REM Save back state before exit (best effort, mirrors trap save_state EXIT)
  if exist "%STATE_DIR%" (
    for %%F in (%STATE_FILES%) do (
      if exist "%%F" copy /y "%%F" "%STATE_DIR%\%%F" >nul 2>&1
    )
  )
  echo [entrypoint] Starting: bun run index.js !ARGS!
  bun run index.js !ARGS!
  exit /b %ERRORLEVEL%
)

echo [entrypoint] Starting: bun run index.js %*
bun run index.js %*
