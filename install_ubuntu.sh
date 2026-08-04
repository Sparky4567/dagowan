#!/usr/bin/env bash
# ==============================================================================
# Installation Script for Standard Ubuntu (Desktop / Server / VPS)
# Tested on Ubuntu 20.04 / 22.04 / 24.04 LTS (x86_64 & ARM64)
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

# Helper to run commands with sudo if not root
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
    if command -v sudo &> /dev/null; then
        SUDO="sudo"
    else
        log_error "This script requires superuser privileges. Please install sudo or run as root."
        exit 1
    fi
fi

log_info "Starting installation for standard Ubuntu..."

# 1. Update APT & Install Core System Dependencies
export DEBIAN_FRONTEND=noninteractive
log_info "Updating package lists & installing system dependencies..."
$SUDO apt-get update -y
$SUDO apt-get install -y --no-install-recommends \
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
    pkg-config \
    libvips-dev

log_success "System packages installed."

# 2. Install Node.js 20 LTS if missing
if ! command -v node &> /dev/null; then
    log_info "Node.js not found. Installing Node.js 20 LTS..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO bash -
    $SUDO apt-get install -y nodejs
    log_success "Node.js installed: $(node -v)"
else
    log_info "Node.js already installed: $(node -v)"
fi

# 3. Install Bun if missing
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

# 4. Install Python Dependencies
log_info "Installing Python dependencies (pypdf, markdown, weasyprint)..."
python3 -m pip install pypdf markdown weasyprint --break-system-packages || true
log_success "Python dependencies installed."

# 5. Install Node / Bun Packages
log_info "Installing project dependencies via Bun..."
bun install

# 6. Apply ONNX & Sharp Patches
log_info "Applying ONNX logging & sharp compatibility patches..."
bun run patch_onnx.js

log_success "=========================================================="
log_success "Ubuntu installation & setup completed successfully!"
log_info    "• For local Ollama models, ensure Ollama daemon is running ('ollama serve &')"
log_info    "• For Cloud models, set API keys with: /set-api-key <provider> <key>"
log_success "To start the application, run: ./starter.sh"
log_success "=========================================================="

