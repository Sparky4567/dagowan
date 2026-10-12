@echo off
REM ==============================================================================
REM dockerize.bat — build ^& run this project as a Docker container.
REM Windows port of dockerize.sh.
REM
REM   dockerize.bat build            Build image (default: dagowan:latest)
REM   dockerize.bat run [--detach]   Run container (interactive CLI by default)
REM   dockerize.bat up [--ollama]    docker compose up (add bundled Ollama svc)
REM   dockerize.bat down             Stop + remove compose stack
REM   dockerize.bat logs [-f]        Show container logs
REM   dockerize.bat shell            Open a shell inside the running container
REM   dockerize.bat stop^|start^|rm    Container lifecycle helpers
REM   dockerize.bat clean            Remove container + image + anonymous volumes
REM
REM Env knobs (or copy .env.example -^> .env):
REM   IMAGE, TAG, CONTAINER, OLLAMA_HOST, WHATSAPP_PORT, WHATSAPP_STATUS_PORT,
REM   VOICE_PORT / WEB_PORT, OPENAI_API_KEY, GEMINI_API_KEY, CLAUDE_API_KEY,
REM   GROK_API_KEY, WHATSAPP_PHONE, WHATSAPP_ENABLED, WEB_ENABLED,
REM   WHATSAPP_QR_MODE (auto^|qr^|pairing^|off), TELEGRAM_TOKEN
REM   ASTRO_HOST_PATH (host Astro checkout to mount),
REM   ASTRO_PROJECT_PATH (container path, default /astro when mounting),
REM   ASTRO_BACKUP_DIR, ASTRO_DEFAULT_LANG, ASTRO_DEFAULT_TEMPLATE
REM
REM WhatsApp is opt-in: the container starts `--web` by default and adds
REM `--whatsapp` only when WHATSAPP_ENABLED=1 or WHATSAPP_PHONE is set.
REM
REM Ports inside the container: 8765 (WhatsApp /chat), 8766 (QR/pairing),
REM 8767 (Dagowan voice Web UI + WebSocket).
REM ==============================================================================
setlocal EnableDelayedExpansion

REM --- Defaults (recomputed AFTER .env load so .env wins) ---
if not defined IMAGE set "IMAGE=dagowan"
if not defined TAG set "TAG=latest"
if not defined CONTAINER set "CONTAINER=dagowan"
if not defined WHATSAPP_PORT set "WHATSAPP_PORT=8765"
if not defined WHATSAPP_STATUS_PORT set "WHATSAPP_STATUS_PORT=8766"
if defined WEB_PORT (
  if not defined VOICE_PORT set "VOICE_PORT=%WEB_PORT%"
)
if not defined VOICE_PORT set "VOICE_PORT=8767"
if not defined OLLAMA_HOST set "OLLAMA_HOST=http://host.docker.internal:11434"

cd /d "%~dp0"

REM --- Load .\.env into the environment when present ---
REM (compose does this too; simple KEY=VALUE parser, skips # comments)
if exist ".env" (
  for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do (
    set "k=%%A"
    set "v=%%B"
    REM .env wins over shell defaults: overwrite the known knobs
    if defined k (
      if /i "!k!"=="IMAGE" set "IMAGE=!v!"
      if /i "!k!"=="TAG" set "TAG=!v!"
      if /i "!k!"=="CONTAINER" set "CONTAINER=!v!"
      if /i "!k!"=="WHATSAPP_PORT" set "WHATSAPP_PORT=!v!"
      if /i "!k!"=="WHATSAPP_STATUS_PORT" set "WHATSAPP_STATUS_PORT=!v!"
      if /i "!k!"=="VOICE_PORT" set "VOICE_PORT=!v!"
      if /i "!k!"=="WEB_PORT" set "VOICE_PORT=!v!"
      if /i "!k!"=="OLLAMA_HOST" set "OLLAMA_HOST=!v!"
      if /i "!k!"=="OPENAI_API_KEY" set "OPENAI_API_KEY=!v!"
      if /i "!k!"=="GEMINI_API_KEY" set "GEMINI_API_KEY=!v!"
      if /i "!k!"=="CLAUDE_API_KEY" set "CLAUDE_API_KEY=!v!"
      if /i "!k!"=="GROK_API_KEY" set "GROK_API_KEY=!v!"
      if /i "!k!"=="WHATSAPP_PHONE" set "WHATSAPP_PHONE=!v!"
      if /i "!k!"=="WHATSAPP_ENABLED" set "WHATSAPP_ENABLED=!v!"
      if /i "!k!"=="WEB_ENABLED" set "WEB_ENABLED=!v!"
      if /i "!k!"=="WHATSAPP_QR_MODE" set "WHATSAPP_QR_MODE=!v!"
      if /i "!k!"=="TELEGRAM_TOKEN" set "TELEGRAM_TOKEN=!v!"
      if /i "!k!"=="ASTRO_HOST_PATH" set "ASTRO_HOST_PATH=!v!"
      if /i "!k!"=="ASTRO_PROJECT_PATH" set "ASTRO_PROJECT_PATH=!v!"
      if /i "!k!"=="ASTRO_BACKUP_DIR" set "ASTRO_BACKUP_DIR=!v!"
      if /i "!k!"=="ASTRO_DEFAULT_LANG" set "ASTRO_DEFAULT_LANG=!v!"
      if /i "!k!"=="ASTRO_DEFAULT_TEMPLATE" set "ASTRO_DEFAULT_TEMPLATE=!v!"
    )
  )
)
if not defined IMAGE set "IMAGE=dagowan"
if not defined TAG set "TAG=latest"
if not defined CONTAINER set "CONTAINER=dagowan"
set "FULL_IMAGE=%IMAGE%:%TAG%"
if not defined WHATSAPP_PORT set "WHATSAPP_PORT=8765"
if not defined WHATSAPP_STATUS_PORT set "WHATSAPP_STATUS_PORT=8766"
if not defined VOICE_PORT set "VOICE_PORT=8767"
if not defined OLLAMA_HOST set "OLLAMA_HOST=http://host.docker.internal:11434"

set "ACTION=%~1"
if not defined ACTION set "ACTION=help"
shift

if /i "%ACTION%"=="build" goto :build
if /i "%ACTION%"=="run" goto :run
if /i "%ACTION%"=="up" goto :up
if /i "%ACTION%"=="down" goto :down
if /i "%ACTION%"=="logs" goto :logs
if /i "%ACTION%"=="shell" goto :shell
if /i "%ACTION%"=="sh" goto :shell
if /i "%ACTION%"=="stop" goto :stop
if /i "%ACTION%"=="start" goto :start
if /i "%ACTION%"=="rm" goto :rm
if /i "%ACTION%"=="remove" goto :rm
if /i "%ACTION%"=="clean" goto :clean
if /i "%ACTION%"=="help" goto :usage
if /i "%ACTION%"=="--help" goto :usage
if /i "%ACTION%"=="-h" goto :usage
echo [ERROR] Unknown command: %ACTION%
goto :usage

REM --- helper: docker compose (v2 preferred, v1 fallback) ---
:compose
docker compose version >nul 2>&1
if not errorlevel 1 (
  docker compose %*
) else (
  docker-compose %*
)
exit /b %ERRORLEVEL%

:need_docker
where docker >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Missing required command: docker
  echo Install Docker Desktop ^(https://docs.docker.com/get-docker/^) or your distro's docker package,
  echo then re-run: dockerize.bat build
  exit /b 1
)
exit /b 0

:build
call :need_docker || exit /b 1
echo [INFO] Building image %FULL_IMAGE% ...
docker build -t "%FULL_IMAGE%" .
echo [OK] Built %FULL_IMAGE%
echo Run it: dockerize.bat run   ^(or: dockerize.bat up^)
exit /b 0

:run
call :need_docker || exit /b 1
set "DETACH="
set "INTERACTIVE=-it"
if /i "%~1"=="--detach" set "DETACH=-d" & set "INTERACTIVE="
if /i "%~1"=="-d" set "DETACH=-d" & set "INTERACTIVE="

docker ps -a --format "{{.Names}}" 2>nul | findstr /x /c:"%CONTAINER%" >nul 2>&1
if not errorlevel 1 (
  echo [INFO] Removing existing container '%CONTAINER%' ...
  docker rm -f "%CONTAINER%" >nul 2>&1
)

REM Host bind dirs must exist before `docker run -v`, or Docker creates them as root.
if not exist notes mkdir notes
if not exist pdfs mkdir pdfs
if not exist projects mkdir projects
if not exist backups mkdir backups
if not exist logs mkdir logs
if not exist tmp mkdir tmp
if not exist data mkdir data
if not exist whatsapp_bridge\auth mkdir whatsapp_bridge\auth

REM WhatsApp is opt-in: default to the web UI only.
set "CMD_ARGS=--web"
if defined WHATSAPP_ENABLED (
  if /i "%WHATSAPP_ENABLED%"=="1" set "CMD_ARGS=--web --whatsapp"
  if /i "%WHATSAPP_ENABLED%"=="true" set "CMD_ARGS=--web --whatsapp"
  if /i "%WHATSAPP_ENABLED%"=="on" set "CMD_ARGS=--web --whatsapp"
  if /i "%WHATSAPP_ENABLED%"=="enable" set "CMD_ARGS=--web --whatsapp"
  if /i "%WHATSAPP_ENABLED%"=="enabled" set "CMD_ARGS=--web --whatsapp"
  if /i "%WHATSAPP_ENABLED%"=="yes" set "CMD_ARGS=--web --whatsapp"
) else (
  if defined WHATSAPP_PHONE set "CMD_ARGS=--web --whatsapp"
)

REM Persist root *.json state when present on the host.
set "JSON_MOUNTS="
for %%F in (app_settings.json characters.json memory.json chat_sessions.json tasks.json mcp_servers.json) do (
  if exist "%CD%\%%F" set "JSON_MOUNTS=!JSON_MOUNTS! -v ""%CD%\%%F:/app/%%F"""
)

REM Astro publishing (@astro-post): mount a host Astro checkout.
set "ASTRO_MOUNT="
if defined ASTRO_HOST_PATH (
  if exist "%ASTRO_HOST_PATH%" (
    if not defined ASTRO_PROJECT_PATH set "ASTRO_PROJECT_PATH=/astro"
    set "ASTRO_MOUNT=-v ""%ASTRO_HOST_PATH%:%ASTRO_PROJECT_PATH%"""
  ) else (
    echo [WARN] ASTRO_HOST_PATH not found: %ASTRO_HOST_PATH% ^(Astro stays unmounted^)
  )
)

echo [INFO] Starting '%CONTAINER%' from %FULL_IMAGE% ...
echo [INFO] Web UI:      http://127.0.0.1:%VOICE_PORT%
echo [INFO] WhatsApp QR: http://127.0.0.1:%WHATSAPP_STATUS_PORT%/qr
echo [INFO] Ollama:      %OLLAMA_HOST%
if defined ASTRO_MOUNT (
  echo [INFO] Astro:      %ASTRO_HOST_PATH% -^> %ASTRO_PROJECT_PATH% ^(use @astro-status in-app^)
) else (
  echo [INFO] Astro:      not mounted ^(set ASTRO_HOST_PATH to enable @astro-post^)
)
echo [INFO] CLI args:    %CMD_ARGS%

REM Build optional -e flags (only for vars that are defined).
set "EXTRA_ENVS="
if defined OPENAI_API_KEY set "EXTRA_ENVS=%EXTRA_ENVS% -e OPENAI_API_KEY=%OPENAI_API_KEY%"
if defined GEMINI_API_KEY set "EXTRA_ENVS=%EXTRA_ENVS% -e GEMINI_API_KEY=%GEMINI_API_KEY%"
if defined CLAUDE_API_KEY set "EXTRA_ENVS=%EXTRA_ENVS% -e CLAUDE_API_KEY=%CLAUDE_API_KEY%"
if defined GROK_API_KEY set "EXTRA_ENVS=%EXTRA_ENVS% -e GROK_API_KEY=%GROK_API_KEY%"
if defined WHATSAPP_PHONE set "EXTRA_ENVS=%EXTRA_ENVS% -e WHATSAPP_PHONE=%WHATSAPP_PHONE%"
if defined WHATSAPP_ENABLED set "EXTRA_ENVS=%EXTRA_ENVS% -e WHATSAPP_ENABLED=%WHATSAPP_ENABLED%"
if defined WEB_ENABLED set "EXTRA_ENVS=%EXTRA_ENVS% -e WEB_ENABLED=%WEB_ENABLED%"
if defined WHATSAPP_QR_MODE set "EXTRA_ENVS=%EXTRA_ENVS% -e WHATSAPP_QR_MODE=%WHATSAPP_QR_MODE%"
if defined TELEGRAM_TOKEN set "EXTRA_ENVS=%EXTRA_ENVS% -e TELEGRAM_TOKEN=%TELEGRAM_TOKEN%"
if defined ASTRO_PROJECT_PATH set "EXTRA_ENVS=%EXTRA_ENVS% -e ASTRO_PROJECT_PATH=%ASTRO_PROJECT_PATH%"
if defined ASTRO_BACKUP_DIR set "EXTRA_ENVS=%EXTRA_ENVS% -e ASTRO_BACKUP_DIR=%ASTRO_BACKUP_DIR%"
if defined ASTRO_DEFAULT_LANG set "EXTRA_ENVS=%EXTRA_ENVS% -e ASTRO_DEFAULT_LANG=%ASTRO_DEFAULT_LANG%"
if defined ASTRO_DEFAULT_TEMPLATE set "EXTRA_ENVS=%EXTRA_ENVS% -e ASTRO_DEFAULT_TEMPLATE=%ASTRO_DEFAULT_TEMPLATE%"

docker run %DETACH% %INTERACTIVE% --name "%CONTAINER%" -p "%WHATSAPP_PORT%:8765" -p "%WHATSAPP_STATUS_PORT%:8766" -p "%VOICE_PORT%:8767" --add-host=host.docker.internal:host-gateway -e BIND_HOST=0.0.0.0 -e HOST=0.0.0.0 -e "OLLAMA_HOST=%OLLAMA_HOST%" -e "WHATSAPP_PORT=8765" -e "WHATSAPP_STATUS_PORT=8766" -e "VOICE_PORT=8767" -e "WEB_PORT=8767" %EXTRA_ENVS% -v dagowan-data:/app/data -v dagowan-wa-auth:/app/whatsapp_bridge/auth -v dagowan-config:/app/config-state -v "%CD%\notes:/app/notes" -v "%CD%\pdfs:/app/pdfs" -v "%CD%\projects:/app/projects" -v "%CD%\backups:/app/backups" -v "%CD%\logs:/app/logs" -v "%CD%\tmp:/app/tmp" %JSON_MOUNTS% %ASTRO_MOUNT% "%FULL_IMAGE%" %CMD_ARGS%
exit /b %ERRORLEVEL%

:up
call :need_docker || exit /b 1
if not exist notes mkdir notes
if not exist pdfs mkdir pdfs
if not exist projects mkdir projects
if not exist backups mkdir backups
if not exist logs mkdir logs
if not exist tmp mkdir tmp
if not exist data mkdir data
if not exist whatsapp_bridge\auth mkdir whatsapp_bridge\auth
set "PROFILE_ARGS="
if /i "%~1"=="--ollama" (
  set "PROFILE_ARGS=--profile ollama"
  if not defined OLLAMA_HOST set "OLLAMA_HOST=http://ollama:11434"
  if "%OLLAMA_HOST%"=="http://host.docker.internal:11434" set "OLLAMA_HOST=http://ollama:11434"
  echo [INFO] Using bundled Ollama service ^(OLLAMA_HOST=!OLLAMA_HOST!^)
  echo [INFO] After startup, pull a model once:  docker exec -it dagowan-ollama ollama pull llama3
)
call :compose %PROFILE_ARGS% up --build -d
echo [OK] Stack is up.
call :compose ps
echo.
echo Web UI:      http://127.0.0.1:%VOICE_PORT%
echo WhatsApp QR: http://127.0.0.1:%WHATSAPP_STATUS_PORT%/qr
echo Attach to CLI: docker attach %CONTAINER%
exit /b 0

:down
call :need_docker || exit /b 1
call :compose down
exit /b %ERRORLEVEL%

:logs
call :need_docker || exit /b 1
if /i "%~1"=="-f" (
  docker logs -f "%CONTAINER%"
) else if /i "%~1"=="--follow" (
  docker logs -f "%CONTAINER%"
) else (
  docker logs --tail 200 "%CONTAINER%"
)
exit /b %ERRORLEVEL%

:shell
call :need_docker || exit /b 1
docker exec -it "%CONTAINER%" /bin/bash
exit /b %ERRORLEVEL%

:stop
docker stop "%CONTAINER%"
exit /b %ERRORLEVEL%

:start
docker start -ai "%CONTAINER%"
exit /b %ERRORLEVEL%

:rm
docker rm -f "%CONTAINER%"
exit /b %ERRORLEVEL%

:clean
call :need_docker || exit /b 1
docker rm -f "%CONTAINER%" >nul 2>&1
docker rmi "%FULL_IMAGE%" >nul 2>&1
docker volume rm dagowan-data dagowan-wa-auth dagowan-config >nul 2>&1
echo [OK] Removed container '%CONTAINER%', image '%FULL_IMAGE%', and local data volumes.
echo Host bind dirs ^(notes/pdfs/projects/backups/logs/tmp^) were left untouched.
exit /b 0

:usage
echo dockerize.bat - build ^& run this project as a Docker container.
echo.
echo   dockerize.bat build            Build image ^(default: dagowan:latest^)
echo   dockerize.bat run [--detach]   Run container ^(interactive CLI by default^)
echo   dockerize.bat up [--ollama]    docker compose up ^(add bundled Ollama svc^)
echo   dockerize.bat down             Stop + remove compose stack
echo   dockerize.bat logs [-f]        Show container logs
echo   dockerize.bat shell            Open a shell inside the running container
echo   dockerize.bat stop^|start^|rm    Container lifecycle helpers
echo   dockerize.bat clean            Remove container + image + anonymous volumes
echo.
echo Examples:
echo   dockerize.bat build ^&^& dockerize.bat run
echo   dockerize.bat run --detach ^&^& dockerize.bat logs -f
echo   dockerize.bat up --ollama
exit /b 0
