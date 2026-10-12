#!/usr/bin/env bash
# ==============================================================================
# dockerize.sh — build & run this project as a Docker container on any machine.
#
#   ./dockerize.sh build            Build image (default: dagowan:latest)
#   ./dockerize.sh run [--detach]   Run container (interactive CLI by default)
#   ./dockerize.sh up [--ollama]    docker compose up (add bundled Ollama svc)
#   ./dockerize.sh down             Stop + remove compose stack
#   ./dockerize.sh logs [-f]        Show container logs
#   ./dockerize.sh shell            Open a shell inside the running container
#   ./dockerize.sh stop|start|rm    Container lifecycle helpers
#   ./dockerize.sh clean            Remove container + image + anonymous volumes
#
# Env knobs (or copy .env.example -> .env):
#   IMAGE, TAG, CONTAINER, OLLAMA_HOST, WHATSAPP_PORT, WHATSAPP_STATUS_PORT,
#   VOICE_PORT / WEB_PORT, OPENAI_API_KEY, GEMINI_API_KEY, CLAUDE_API_KEY,
#   GROK_API_KEY, WHATSAPP_PHONE, WHATSAPP_ENABLED, WEB_ENABLED,
#   WHATSAPP_QR_MODE (auto|qr|pairing|off), TELEGRAM_TOKEN
#
# WhatsApp is opt-in: the container starts `--web` by default and adds
# `--whatsapp` only when WHATSAPP_ENABLED=1 or WHATSAPP_PHONE is set.
# On Termux (WHATSAPP_QR_MODE=auto) the bridge prints an 8-digit numeric
# pairing code instead of a QR code (see @whatsapp-pair).
#
# Ports inside the container: 8765 (WhatsApp /chat), 8766 (QR/pairing),
# 8767 (Dagowan voice Web UI + WebSocket).
# ==============================================================================
set -euo pipefail 2>/dev/null || set -e

IMAGE="${IMAGE:-dagowan}"
TAG="${TAG:-latest}"
CONTAINER="${CONTAINER:-dagowan}"
FULL_IMAGE="${IMAGE}:${TAG}"

WHATSAPP_PORT="${WHATSAPP_PORT:-8765}"
WHATSAPP_STATUS_PORT="${WHATSAPP_STATUS_PORT:-8766}"
VOICE_PORT="${VOICE_PORT:-${WEB_PORT:-8767}}"
OLLAMA_HOST_DEFAULT="http://host.docker.internal:11434"
OLLAMA_HOST="${OLLAMA_HOST:-$OLLAMA_HOST_DEFAULT}"

cd "$(dirname "$0")"

# Load ./.env into the environment when present (compose does this too).
# NOTE: port/image defaults are (re)computed AFTER the load so values from
# .env win over the shell defaults above.
if [ -f "./.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "./.env"
  set +a
fi
IMAGE="${IMAGE:-dagowan}"
TAG="${TAG:-latest}"
CONTAINER="${CONTAINER:-dagowan}"
FULL_IMAGE="${IMAGE}:${TAG}"
WHATSAPP_PORT="${WHATSAPP_PORT:-8765}"
WHATSAPP_STATUS_PORT="${WHATSAPP_STATUS_PORT:-8766}"
VOICE_PORT="${VOICE_PORT:-${WEB_PORT:-8767}}"
OLLAMA_HOST_DEFAULT="http://host.docker.internal:11434"
OLLAMA_HOST="${OLLAMA_HOST:-$OLLAMA_HOST_DEFAULT}"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "[ERROR] Missing required command: $1" >&2
    echo "Install Docker Desktop (https://docs.docker.com/get-docker/) or your distro's docker package," >&2
    echo "then re-run: ./dockerize.sh build" >&2
    exit 1
  }
}

compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
  else
    docker-compose "$@"
  fi
}

usage() {
  sed -n '2,/^# ==/p' "$0" | sed 's/^# \{0,1\}//'
  echo ""
  echo "Examples:"
  echo "  ./dockerize.sh build && ./dockerize.sh run"
  echo "  ./dockerize.sh run --detach && ./dockerize.sh logs -f"
  echo "  ./dockerize.sh up --ollama        # also starts bundled Ollama daemon"
  echo "  OLLAMA_HOST=http://ollama:11434 ./dockerize.sh up --ollama"
}

cmd_build() {
  need docker
  echo "[INFO] Building image ${FULL_IMAGE} ..."
  docker build -t "${FULL_IMAGE}" .
  echo "[OK] Built ${FULL_IMAGE}"
  echo "Run it: ./dockerize.sh run   (or: ./dockerize.sh up)"
}

cmd_run() {
  need docker
  DETACH=""
  INTERACTIVE="-it"
  if [ "${1:-}" = "--detach" ] || [ "${1:-}" = "-d" ]; then DETACH="-d"; INTERACTIVE=""; fi

  if docker ps -a --format '{{.Names}}' | grep -qx "${CONTAINER}"; then
    echo "[INFO] Removing existing container '${CONTAINER}' ..."
    docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
  fi

  # Host bind dirs must exist before `docker run -v host:container`, or
  # Docker creates them as root. `notes` is gitignored and often missing.
  mkdir -p notes pdfs projects backups logs tmp data whatsapp_bridge/auth 2>/dev/null || true

  # WhatsApp is opt-in: default to the web UI only so an unconfigured
  # container never QR-spams. Add --whatsapp only when explicitly enabled.
  CMD_ARGS="--web"
  case "${WHATSAPP_ENABLED:-}" in
    1|true|TRUE|on|ON|enable|enabled|yes|YES) CMD_ARGS="--web --whatsapp" ;;
    0|false|FALSE|off|OFF|disable|disabled|no|NO) CMD_ARGS="--web" ;;
    *)
      if [ -n "${WHATSAPP_PHONE:-}" ]; then
        CMD_ARGS="--web --whatsapp"
      fi
      ;;
  esac

  # Persist root *.json state when present on the host so edits inside the
  # container (`@set-*`, sessions, tasks) survive rebuilds. Missing files
  # fall back to the dagowan-config named volume (see entrypoint sync).
  JSON_MOUNTS=""
  for f in app_settings.json characters.json memory.json chat_sessions.json tasks.json mcp_servers.json; do
    if [ -f "$PWD/$f" ]; then
      JSON_MOUNTS="$JSON_MOUNTS -v $PWD/$f:/app/$f"
    fi
  done

  echo "[INFO] Starting '${CONTAINER}' from ${FULL_IMAGE} ..."
  echo "[INFO] Web UI:      http://127.0.0.1:${VOICE_PORT}"
  echo "[INFO] WhatsApp QR: http://127.0.0.1:${WHATSAPP_STATUS_PORT}/qr"
  echo "[INFO] Ollama:      ${OLLAMA_HOST}"
  echo "[INFO] CLI args:    ${CMD_ARGS}"

  # NOTE: host bind-mounts cover notes/pdfs/projects/backups/logs/tmp (+ any
  # root *.json files above); named volumes cover data (SQLite), WhatsApp
  # auth, and dagowan-config (*.json fallback when no host file exists).
  # shellcheck disable=SC2086
  docker run $DETACH $INTERACTIVE \
    --name "${CONTAINER}" \
    -p "${WHATSAPP_PORT}:8765" \
    -p "${WHATSAPP_STATUS_PORT}:8766" \
    -p "${VOICE_PORT}:8767" \
    --add-host=host.docker.internal:host-gateway \
    -e BIND_HOST=0.0.0.0 \
    -e HOST=0.0.0.0 \
    -e "OLLAMA_HOST=${OLLAMA_HOST}" \
    -e "WHATSAPP_PORT=8765" \
    -e "WHATSAPP_STATUS_PORT=8766" \
    -e "VOICE_PORT=8767" \
    -e "WEB_PORT=8767" \
    ${OPENAI_API_KEY:+-e OPENAI_API_KEY="$OPENAI_API_KEY"} \
    ${GEMINI_API_KEY:+-e GEMINI_API_KEY="$GEMINI_API_KEY"} \
    ${CLAUDE_API_KEY:+-e CLAUDE_API_KEY="$CLAUDE_API_KEY"} \
    ${GROK_API_KEY:+-e GROK_API_KEY="$GROK_API_KEY"} \
    ${WHATSAPP_PHONE:+-e WHATSAPP_PHONE="$WHATSAPP_PHONE"} \
    ${WHATSAPP_ENABLED:+-e WHATSAPP_ENABLED="$WHATSAPP_ENABLED"} \
    ${WEB_ENABLED:+-e WEB_ENABLED="$WEB_ENABLED"} \
    ${WHATSAPP_QR_MODE:+-e WHATSAPP_QR_MODE="$WHATSAPP_QR_MODE"} \
    ${TELEGRAM_TOKEN:+-e TELEGRAM_TOKEN="$TELEGRAM_TOKEN"} \
    -v dagowan-data:/app/data \
    -v dagowan-wa-auth:/app/whatsapp_bridge/auth \
    -v dagowan-config:/app/config-state \
    -v "$PWD/notes:/app/notes" \
    -v "$PWD/pdfs:/app/pdfs" \
    -v "$PWD/projects:/app/projects" \
    -v "$PWD/backups:/app/backups" \
    -v "$PWD/logs:/app/logs" \
    -v "$PWD/tmp:/app/tmp" \
    $JSON_MOUNTS \
    "${FULL_IMAGE}" $CMD_ARGS
}

cmd_up() {
  need docker
  # Same reason as cmd_run: compose bind-mounts need host dirs to exist.
  mkdir -p notes pdfs projects backups logs tmp data whatsapp_bridge/auth 2>/dev/null || true
  PROFILE_ARGS=""
  if [ "${1:-}" = "--ollama" ]; then
    PROFILE_ARGS="--profile ollama"
    if [ -z "${OLLAMA_HOST:-}" ] || [ "${OLLAMA_HOST}" = "http://host.docker.internal:11434" ]; then
      export OLLAMA_HOST="http://ollama:11434"
    fi
    echo "[INFO] Using bundled Ollama service (OLLAMA_HOST=${OLLAMA_HOST})"
    echo "[INFO] After startup, pull a model once:  docker exec -it dagowan-ollama ollama pull llama3"
  fi
  # shellcheck disable=SC2086
  compose $PROFILE_ARGS up --build -d
  echo "[OK] Stack is up."
  compose ps
  echo ""
  echo "Web UI:      http://127.0.0.1:${VOICE_PORT}"
  echo "WhatsApp QR: http://127.0.0.1:${WHATSAPP_STATUS_PORT}/qr"
  echo "Attach to CLI: docker attach ${CONTAINER}"
}

cmd_down() {
  need docker
  compose down
}

cmd_logs() {
  need docker
  if [ "${1:-}" = "-f" ] || [ "${1:-}" = "--follow" ]; then
    docker logs -f "${CONTAINER}"
  else
    docker logs --tail 200 "${CONTAINER}"
  fi
}

cmd_shell() {
  need docker
  docker exec -it "${CONTAINER}" /bin/bash
}

cmd_clean() {
  need docker
  docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
  docker rmi "${FULL_IMAGE}" >/dev/null 2>&1 || true
  docker volume rm dagowan-data dagowan-wa-auth dagowan-config >/dev/null 2>&1 || true
  echo "[OK] Removed container '${CONTAINER}', image '${FULL_IMAGE}', and local data volumes."
  echo "Host bind dirs (notes/pdfs/projects/backups/logs/tmp) were left untouched."
}

ACTION="${1:-help}"
case "${ACTION}" in
  build) shift; cmd_build "$@" ;;
  run) shift; cmd_run "$@" ;;
  up) shift; cmd_up "$@" ;;
  down) shift; cmd_down "$@" ;;
  logs) shift; cmd_logs "$@" ;;
  shell|sh) shift; cmd_shell "$@" ;;
  stop) docker stop "${CONTAINER}" ;;
  start) docker start -ai "${CONTAINER}" ;;
  rm|remove) docker rm -f "${CONTAINER}" ;;
  clean) shift; cmd_clean "$@" ;;
  help|--help|-h|"") usage ;;
  *) echo "[ERROR] Unknown command: ${ACTION}" >&2; usage; exit 1 ;;
esac
