#!/usr/bin/env bash
# ==============================================================================
# Llama App Startup Script
# ==============================================================================

set -e

export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
export SHARP_IGNORE_GLOBAL_LIBVIPS=1

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo "[INFO] node_modules directory not found. Running installation..."
    ./install.sh
fi

# Re-apply patches to ensure node_modules is always up to date
bun run patch_onnx.js

echo "[INFO] Starting application..."
exec bun run index.js "$@"
