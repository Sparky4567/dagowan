# syntax=docker/dockerfile:1
FROM oven/bun:1-debian AS base

ENV DEBIAN_FRONTEND=noninteractive \
    SHARP_IGNORE_GLOBAL_LIBVIPS=1 \
    BUN_INSTALL="/root/.bun"

# System runtime deps:
# - nodejs: whatsapp_bridge spawns `node whatsapp_bridge/index.js`
# - python3/pip: md_to_pdf.py / pdf_to_md.py helpers
# - ffmpeg/espeak: local voice notes & audio conversion
# - libvips-dev/pkg-config/build-essential: sharp fallback builds
RUN apt-get update -y && apt-get install -y --no-install-recommends \
        ca-certificates curl git unzip \
        nodejs npm \
        python3 python3-pip python3-venv \
        ffmpeg espeak espeak-ng \
        build-essential pkg-config libvips-dev \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m pip install --no-cache-dir --break-system-packages pypdf markdown weasyprint cactus-needle 2>/dev/null \
        || python3 -m pip install --no-cache-dir --break-system-packages pypdf markdown cactus-needle 2>/dev/null \
        || python3 -m pip install --no-cache-dir --break-system-packages pypdf markdown 2>/dev/null \
        || true

WORKDIR /app

# Install JS deps first (better layer caching)
COPY package.json bun.lock patch_onnx.js ./
COPY whatsapp_bridge/package.json ./whatsapp_bridge/package.json
RUN bun install --ignore-scripts || bun install
RUN npm install --prefix whatsapp_bridge --no-audit --no-fund || true

# Copy the rest of the project (defaults for settings/characters/etc.)
COPY . .

# Re-apply ONNX/Sharp/canvas runtime patches + ensure runtime dirs exist
RUN bun run patch_onnx.js || true
# Headless-browser engine for the agentic @youtube-play / @browser-* commands
RUN bunx --bun playwright install --with-deps chromium || bunx --bun playwright install chromium || true
RUN mkdir -p data backups logs tmp notes pdfs projects whatsapp_bridge/auth \
    && chmod +x docker-entrypoint.sh dockerize.sh starter.sh install.sh 2>/dev/null || true

# Dagowan Voice Web UI / WhatsApp bridges / Dashboard
EXPOSE 8765 8766 8767 8768

ENV BIND_HOST=0.0.0.0 \
    HOST=0.0.0.0 \
    WHATSAPP_PORT=8765 \
    WHATSAPP_STATUS_PORT=8766 \
    VOICE_PORT=8767 \
    WEB_PORT=8767 \
    DASHBOARD_PORT=8768 \
    OLLAMA_HOST=http://host.docker.internal:11434

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD sh -c 'curl -fsS http://127.0.0.1:8765/health || curl -fsS http://127.0.0.1:8767/ || exit 1'

ENTRYPOINT ["/app/docker-entrypoint.sh"]
# WhatsApp is opt-in (WHATSAPP_ENABLED=1 / WHATSAPP_PHONE / --whatsapp).
# Default to the web UI only so a plain `docker run` never QR-spams.
CMD ["--web"]
