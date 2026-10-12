@echo off
REM ==============================================================================
REM Llama App Startup Script (Windows port of starter.sh)
REM ==============================================================================
setlocal

REM Add common locations (Bun, Local bin) to PATH when present
if exist "%USERPROFILE%\.bun\bin" set "PATH=%USERPROFILE%\.bun\bin;%PATH%"
if exist "%LOCALAPPDATA%\Programs\Bun" set "PATH=%LOCALAPPDATA%\Programs\Bun;%PATH%"
if defined BUN_INSTALL (
  if exist "%BUN_INSTALL%\bin" set "PATH=%BUN_INSTALL%\bin;%PATH%"
)

set "SHARP_IGNORE_GLOBAL_LIBVIPS=1"

REM Check if Bun is installed
where bun >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Bun is not installed or not found in PATH.
  echo [INFO] Running install.bat to setup dependencies...
  if exist "%~dp0install.bat" (
    call "%~dp0install.bat"
  ) else (
    echo [ERROR] Please install Bun from https://bun.sh
    exit /b 1
  )
  where bun >nul 2>nul
  if errorlevel 1 (
    echo [ERROR] Bun is still missing after install. Aborting.
    exit /b 1
  )
)

REM Check if node_modules exists
if not exist "%~dp0node_modules" (
  echo [INFO] node_modules directory not found. Installing dependencies...
  pushd "%~dp0"
  bun install --ignore-scripts
  if errorlevel 1 bun install
  bun run patch_onnx.js
  popd
)

REM Self-heal WhatsApp bridge deps (spawned as `node whatsapp_bridge/index.js`).
REM Root node_modules usually covers it via Node resolution, but keep the
REM isolated bridge install present when its package.json exists.
if exist "%~dp0whatsapp_bridge\package.json" (
  if not exist "%~dp0whatsapp_bridge\node_modules" (
    echo [INFO] whatsapp_bridge\node_modules not found. Installing bridge dependencies...
    pushd "%~dp0"
    REM Child cmd: a failing npm must not terminate this script (see install.bat).
    cmd /d /c "npm install --prefix whatsapp_bridge --no-audit --no-fund >nul 2>&1"
    if errorlevel 1 bun install --cwd whatsapp_bridge >nul 2>&1
    if errorlevel 1 echo [WARNING] WhatsApp bridge install failed ^(continuing with root node_modules^).
    popd
  )
)

REM Re-apply patches to ensure node_modules is always up to date
pushd "%~dp0"
bun run patch_onnx.js >nul 2>&1
popd

echo [INFO] Starting application...
pushd "%~dp0"
bun run index.js %*
popd
