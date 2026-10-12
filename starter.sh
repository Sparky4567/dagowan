#!/usr/bin/env bash
# ==============================================================================
# Llama App Startup Script
# Full support for Bash, Zsh, and POSIX environments.
# ==============================================================================

set -e

# Setup common PATH locations (Homebrew, Local, Bun)
for p in "/opt/homebrew/bin" "/usr/local/bin" "$HOME/.local/bin" "$HOME/.bun/bin"; do
    if [ -d "$p" ]; then
        case ":$PATH:" in
            *:"$p":*) ;;
            *) export PATH="$p:$PATH" ;;
        esac
    fi
done

if [ -d "$HOME/.bun/bin" ]; then
    export BUN_INSTALL="$HOME/.bun"
    export PATH="$BUN_INSTALL/bin:$PATH"
fi

export SHARP_IGNORE_GLOBAL_LIBVIPS=1

# Check if Bun is installed
if ! command -v bun > /dev/null 2>&1; then
    echo "[ERROR] Bun is not installed or not found in PATH."
    echo "[INFO] Running ./install.sh to setup dependencies..."
    if [ -f "./install.sh" ]; then
        chmod +x ./install.sh
        if [ -n "${ZSH_VERSION:-}" ] && command -v zsh > /dev/null 2>&1; then
            zsh ./install.sh
        else
            bash ./install.sh 2>/dev/null || ./install.sh
        fi
    else
        echo "[ERROR] Please install Bun from https://bun.sh"
        exit 1
    fi
fi

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo "[INFO] node_modules directory not found. Installing dependencies..."
    bun install --ignore-scripts || bun install
    bun run patch_onnx.js
fi

# Self-heal WhatsApp bridge deps (spawned as `node whatsapp_bridge/index.js`).
# Root node_modules usually covers it via Node resolution, but keep the
# isolated bridge install present when its package.json exists.
if [ -f "whatsapp_bridge/package.json" ] && [ ! -d "whatsapp_bridge/node_modules" ]; then
    echo "[INFO] whatsapp_bridge/node_modules not found. Installing bridge dependencies..."
    npm install --prefix whatsapp_bridge --no-audit --no-fund > /dev/null 2>&1 || \
    echo "[WARNING] WhatsApp bridge install failed (continuing with root node_modules)."
fi

# Re-apply patches to ensure node_modules is always up to date
bun run patch_onnx.js > /dev/null 2>&1 || true

echo "[INFO] Starting application..."
exec bun run index.js "$@"
