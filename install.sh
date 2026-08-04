#!/usr/bin/env bash
# ==============================================================================
# Universal PRoot-Distro Ubuntu Installation Script for Llama App
# Works on ALL Android devices running PRoot-Distro Ubuntu / Termux
# ==============================================================================

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARNING]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

log_info "Starting universal PRoot-Distro Ubuntu installation..."

# 1. Update APT & Install Core System Dependencies
export DEBIAN_FRONTEND=noninteractive
log_info "Updating package lists & installing system dependencies..."
apt-get update -y
apt-get install -y --no-install-recommends \
    curl \
    wget \
    git \
    build-essential \
    python3 \
    python3-pip \
    python3-dev \
    python3-venv \
    ffmpeg \
    espeak \
    ca-certificates \
    unzip \
    pkg-config

log_success "System packages installed."

# 2. Setup Node.js if missing
if ! command -v node &> /dev/null; then
    log_info "Node.js not found. Installing Node.js 20..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
    log_success "Node.js installed: $(node -v)"
else
    log_info "Node.js already installed: $(node -v)"
fi

# 3. Setup Bun if missing
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"

if ! command -v bun &> /dev/null; then
    log_info "Bun not found. Installing Bun..."
    curl -fsSL https://bun.sh/install | bash
    export PATH="$BUN_INSTALL/bin:$PATH"

    for PROFILE in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
        if [ -f "$PROFILE" ]; then
            if ! grep -q 'BUN_INSTALL' "$PROFILE"; then
                echo '' >> "$PROFILE"
                echo 'export BUN_INSTALL="$HOME/.bun"' >> "$PROFILE"
                echo 'export PATH="$BUN_INSTALL/bin:$PATH"' >> "$PROFILE"
            fi
        fi
    done
    log_success "Bun installed: $(bun -v)"
else
    log_info "Bun already installed: $(bun -v)"
fi

# 4. Setup Python Dependencies
log_info "Installing Python dependencies (pypdf, markdown, etc.)..."
python3 -m pip install pypdf markdown weasyprint --break-system-packages || true
log_success "Python dependencies installed."

# 5. Clean Old Node Modules and Cache
log_info "Clearing Bun package cache and node_modules..."
rm -rf "$BUN_INSTALL/install/cache" node_modules bun.lock

# 6. Install NPM Packages using --ignore-scripts (prevents native gyp compile errors on Android)
log_info "Installing project packages via Bun..."
bun install --ignore-scripts

# 7. Execute Post-Install Patches
log_info "Applying ONNX & Sharp patches via patch_onnx.js..."
bun run patch_onnx.js

log_success "=========================================================="
log_success "Installation & patching completed successfully!"
log_info    "• For local Ollama models, ensure Ollama daemon is running ('ollama serve &')"
log_info    "• For Cloud models, set API keys with: /set-api-key <provider> <key>"
log_success "To start the application, run: ./starter.sh"
log_success "=========================================================="

