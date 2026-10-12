@echo off
REM ==============================================================================
REM Universal Multi-Platform Installation Script for Llama App
REM Windows port of install.sh
REM Installs: Node.js 20 LTS, Bun, Python deps, project packages (Bun),
REM WhatsApp bridge deps, ONNX/sharp patches, Playwright Chromium.
REM Requires: Windows 10/11. Uses winget when available, else prints
REM manual install hints. Run from the project root.
REM ==============================================================================
setlocal EnableDelayedExpansion

cd /d "%~dp0"

echo [INFO] Starting Universal Llama App installation (Windows)...

REM --- 1. Check for winget (best-effort auto install of system deps) ---
where winget >nul 2>nul
if errorlevel 1 (
  echo [WARNING] winget not found. Install missing tools manually:
  echo [WARNING]   Node.js 20 LTS: https://nodejs.org/
  echo [WARNING]   Bun: powershell -c "irm bun.sh/install.ps1 ^| iex"
  echo [WARNING]   Python 3 + ffmpeg + git: https://www.python.org/ , https://ffmpeg.org/ , https://git-scm.com/
) else (
  echo [INFO] Checking system dependencies via winget...
  where git.exe >nul 2>nul
  if errorlevel 1 (
    echo [INFO] Installing Git...
    winget install --id Git.Git -e --silent --accept-package-agreements --accept-source-agreements || echo [WARNING] Git install failed, install manually.
  )
  where node >nul 2>nul
  if errorlevel 1 (
    echo [INFO] Installing Node.js 20 LTS...
    winget install --id OpenJS.NodeJS.LTS -e --silent --accept-package-agreements --accept-source-agreements || echo [WARNING] Node.js install failed, install manually from https://nodejs.org/
  ) else (
    for /f "delims=" %%v in ('node -v 2^>nul') do echo [INFO] Node.js detected: %%v
  )
  where python >nul 2>nul
  if errorlevel 1 (
    echo [INFO] Installing Python 3...
    winget install --id Python.Python.3 -e --silent --accept-package-agreements --accept-source-agreements || echo [WARNING] Python install failed, install manually.
  )
  where ffmpeg >nul 2>nul
  if errorlevel 1 (
    echo [INFO] Installing ffmpeg ^(best effort^)...
    winget install --id Gyan.FFmpeg -e --silent --accept-package-agreements --accept-source-agreements || echo [WARNING] ffmpeg install skipped. Some audio/video features need it.
  )
)

REM Refresh PATH entries winget may have added (best effort, session only)
for %%P in ("%LOCALAPPDATA%\Programs\Python" "%PROGRAMFILES%\nodejs" "%PROGRAMFILES%\Git\bin") do (
  if exist %%P set "PATH=%%~P;!PATH!"
)
REM WinGet ffmpeg needs a shell restart for PATH; pick up its bin dir now.
for /d %%D in ("%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg_*") do (
  for /d %%B in ("%%D\ffmpeg-*\bin") do (
    if exist "%%B\ffmpeg.exe" set "PATH=%%B;!PATH!"
  )
)
if exist "%USERPROFILE%\.bun\bin" set "PATH=%USERPROFILE%\.bun\bin;!PATH!"

REM --- 2. Node.js check (warn if still missing) ---
where node >nul 2>nul
if errorlevel 1 (
  echo [WARNING] Node.js is missing. Please install Node.js v18+ or v20+ from https://nodejs.org/ then re-run install.bat.
) else (
  for /f "delims=" %%v in ('node -v 2^>nul') do echo [INFO] Node.js detected: %%v
)

REM --- 3. Bun runtime ---
where bun >nul 2>nul
if errorlevel 1 (
  echo [INFO] Bun not found. Installing Bun runtime...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "irm bun.sh/install.ps1 | iex"
  if exist "%USERPROFILE%\.bun\bin" set "PATH=%USERPROFILE%\.bun\bin;!PATH!"
  set "BUN_INSTALL=%USERPROFILE%\.bun"
  where bun >nul 2>nul
  if errorlevel 1 (
    echo [ERROR] Bun install failed. Install manually from https://bun.sh then re-run install.bat.
    exit /b 1
  )
  for /f "delims=" %%v in ('bun -v 2^>nul') do echo [SUCCESS] Bun installed: %%v
) else (
  for /f "delims=" %%v in ('bun -v 2^>nul') do echo [INFO] Bun detected: %%v
)
if not defined BUN_INSTALL set "BUN_INSTALL=%USERPROFILE%\.bun"

REM --- 4. Python dependencies ---
echo [INFO] Installing Python dependencies (pypdf, markdown, weasyprint, cactus-needle)...
set "PY=python"
where python >nul 2>nul
if errorlevel 1 (
  where python3 >nul 2>nul
  if not errorlevel 1 set "PY=python3"
)
%PY% -m pip install pypdf markdown weasyprint cactus-needle --break-system-packages >nul 2>&1
if errorlevel 1 %PY% -m pip install pypdf markdown cactus-needle --break-system-packages >nul 2>&1
if errorlevel 1 %PY% -m pip install pypdf markdown --break-system-packages >nul 2>&1
if errorlevel 1 %PY% -m pip install pypdf markdown >nul 2>&1
if errorlevel 1 (
  echo [WARNING] Some Python packages may have failed to install. Continuing.
) else (
  echo [SUCCESS] Python dependencies verified.
)

REM --- 4b. Pre-seed Needle on-device engine + weights (best effort, ~40MB) ---
if exist "src\needle_bridge.py" (
  echo [INFO] Pre-seeding Needle on-device engine ^(best effort^)...
  %PY% -c "import sys; sys.path.insert(0, 'src'); from needle_bridge import ensure_engine; ensure_engine()" >nul 2>&1
  if not errorlevel 1 (
    %PY% -c "from needle.agent.fetch import fetch_weights; fetch_weights(3)" >nul 2>&1
    if not errorlevel 1 (
      echo [SUCCESS] Needle on-device engine ready.
    ) else (
      echo [WARNING] Needle engine pre-seed skipped ^(offline?^). It self-heals on first @needle use.
    )
  ) else (
    echo [WARNING] Needle engine pre-seed skipped ^(offline?^). It self-heals on first @needle use.
  )
)

REM --- 5. Install project packages via Bun ---
echo [INFO] Installing project packages via Bun...
set "SHARP_IGNORE_GLOBAL_LIBVIPS=1"
bun install --ignore-scripts
if errorlevel 1 bun install

REM --- 5b. WhatsApp Baileys bridge dependencies (Node whatsapp_bridge/) ---
if exist "whatsapp_bridge\package.json" (
  echo [INFO] Installing WhatsApp bridge packages ^(whatsapp_bridge/^)...
  REM NOTE: npm is launched in a child cmd so a failing npm (e.g. EALLOWGIT
  REM on its git+ssh dep) can never terminate this script. `call npm` is
  REM unsafe here: npm.cmd can abort the parent session on failure.
  cmd /d /c "npm install --prefix whatsapp_bridge --no-audit --no-fund >nul 2>&1"
  if errorlevel 1 (
    echo [INFO] npm bridge install failed, trying Bun instead...
    bun install --cwd whatsapp_bridge >nul 2>&1
  )
  if errorlevel 1 echo [WARNING] WhatsApp bridge install skipped ^(bridge will fall back to root node_modules^). Retry later with: npm install --prefix whatsapp_bridge
)

REM --- 6. Initialize app directories ---
if not exist data mkdir data
if not exist pdfs mkdir pdfs
if not exist backups mkdir backups
if not exist logs mkdir logs
if not exist tmp mkdir tmp
if not exist notes mkdir notes
if not exist projects mkdir projects

REM --- 7. Post-install patches ---
echo [INFO] Applying ONNX WASM and Sharp compatibility patches via patch_onnx.js...
bun run patch_onnx.js
bun run patch_onnx.js --check >nul 2>&1
if errorlevel 1 echo [WARNING] patch_onnx.js --check reported a problem ^(see above^). App will still run; update the patch search strings if a dependency was upgraded.

REM --- 7b. Playwright Chromium engine (best effort, ~170MB download) ---
echo [INFO] Installing Playwright Chromium engine (best effort, ~170MB download)...
bunx --bun playwright install chromium >nul 2>&1
if errorlevel 1 (
  REM bunx --bun mis-handles Playwright's downloader on Windows; retry via node.
  cmd /d /c "npx --yes playwright install chromium >nul 2>&1"
)
if errorlevel 1 echo [WARNING] Playwright Chromium install skipped ^(browser commands will print the manual install hint^). Retry later with: bunx playwright install chromium

echo [SUCCESS] ==========================================================
echo [SUCCESS] Installation and patching completed successfully!
echo [INFO]    - For local Ollama models: start Ollama daemon ('ollama serve')
echo [INFO]    - For Cloud models (Gemini/Claude/OpenAI/Grok): set API keys via /set-api-key
echo [INFO]    - BabyAGI is included and stores its local function registry in data\babyagi.sqlite
echo [INFO]    - Headless browser engine (Playwright/Chromium) installed for @youtube-play and @browser-* commands
echo [INFO]    - Needle on-device engine (cactus-needle) pre-seeded for @needle commands; enable the auto fast-path in-app with @set-setting needle_enabled 1
echo [INFO]    - The first available Ollama model is selected on first launch; /model keeps all assistant tools synchronized
echo [INFO]    - For Web Voice UI: launch with starter.bat --web
echo [SUCCESS] To start the application, run: starter.bat
echo [SUCCESS] ==========================================================
