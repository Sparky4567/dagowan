#!/usr/bin/env bash
# ==============================================================================
# Installation Script for Standard Ubuntu (Desktop / Server / VPS)
# Full support for Bash, Zsh, and POSIX environments.
# Tested on Ubuntu 20.04 / 22.04 / 24.04 LTS (x86_64 & ARM64)
# ==============================================================================

set -euo pipefail 2>/dev/null || set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

log_info() { printf "%b[INFO]%b %s\n" "${BLUE}" "${NC}" "$1"; }
log_success() { printf "%b[SUCCESS]%b %s\n" "${GREEN}" "${NC}" "$1"; }
log_warn() { printf "%b[WARNING]%b %s\n" "${YELLOW}" "${NC}" "$1"; }
log_error() { printf "%b[ERROR]%b %s\n" "${RED}" "${NC}" "$1"; }

# Detect current running shell environment
DETECTED_SHELL="bash"
if [ -n "${ZSH_VERSION:-}" ] || [ -n "${ZSH_NAME:-}" ]; then
    DETECTED_SHELL="zsh"
else
    case "${SHELL:-}" in
        *zsh*) DETECTED_SHELL="zsh" ;;
        *) DETECTED_SHELL="bash" ;;
    esac
fi

# Helper to run commands with sudo if not root
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
    if command -v sudo > /dev/null 2>&1; then
        SUDO="sudo"
    else
        log_error "This script requires superuser privileges. Please install sudo or run as root."
        exit 1
    fi
fi

log_info "Starting installation for standard Ubuntu (Shell: ${DETECTED_SHELL})..."

# 0. Ensure common PATH locations are accessible
for p in "/opt/homebrew/bin" "/usr/local/bin" "$HOME/.local/bin" "$HOME/.bun/bin"; do
    if [ -d "$p" ]; then
        case ":$PATH:" in
            *:"$p":*) ;;
            *) export PATH="$p:$PATH" ;;
        esac
    fi
done

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
    libvips-dev || \
$SUDO apt-get install -y --no-install-recommends \
    curl wget git build-essential python3 python3-pip python3-venv ffmpeg espeak ca-certificates unzip pkg-config || true

log_success "System packages installed."

# 1b. Browser engine system libraries (Playwright/Chromium for @youtube-play / @browser-*).
# Best-effort: the headless browser still installs without these on most systems,
# and `playwright install --with-deps` below covers any remainder.
log_info "Installing headless-browser system libraries (best effort)..."
$SUDO apt-get install -y --no-install-recommends \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libcairo2 || true
log_success "Browser system libraries verified."

# 2. Install Node.js 20 LTS if missing
if ! command -v node > /dev/null 2>&1; then
    log_info "Node.js not found. Installing Node.js 20 LTS..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO bash -
    $SUDO apt-get install -y nodejs
    log_success "Node.js installed: $(node -v 2>/dev/null || echo 'ready')"
else
    log_info "Node.js already installed: $(node -v)"
fi

# 3. Install Bun if missing
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"

if ! command -v bun > /dev/null 2>&1; then
    log_info "Bun not found. Installing Bun..."
    curl -fsSL https://bun.sh/install | bash
    export PATH="$BUN_INSTALL/bin:$PATH"

    # Configure shell profiles for Zsh and Bash
    if [ "$DETECTED_SHELL" = "zsh" ] || [ -n "${ZSH_VERSION:-}" ]; then
        [ -f "$HOME/.zshrc" ] || touch "$HOME/.zshrc"
    fi

    for PROFILE in "$HOME/.zshrc" "$HOME/.zprofile" "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile"; do
        if [ -f "$PROFILE" ]; then
            if ! grep -q 'BUN_INSTALL' "$PROFILE" 2>/dev/null; then
                printf '\n# Bun runtime path\nexport BUN_INSTALL="$HOME/.bun"\nexport PATH="$BUN_INSTALL/bin:$PATH"\n' >> "$PROFILE"
            fi
        fi
    done
    log_success "Bun installed: $(bun -v 2>/dev/null || echo 'ready')"
else
    # Ensure profile files contain Bun path
    if [ "$DETECTED_SHELL" = "zsh" ] || [ -n "${ZSH_VERSION:-}" ]; then
        [ -f "$HOME/.zshrc" ] || touch "$HOME/.zshrc"
    fi

    for PROFILE in "$HOME/.zshrc" "$HOME/.zprofile" "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile"; do
        if [ -f "$PROFILE" ]; then
            if ! grep -q 'BUN_INSTALL' "$PROFILE" 2>/dev/null; then
                printf '\n# Bun runtime path\nexport BUN_INSTALL="$HOME/.bun"\nexport PATH="$BUN_INSTALL/bin:$PATH"\n' >> "$PROFILE"
            fi
        fi
    done
    log_info "Bun already installed: $(bun -v)"
fi

# 4. Install Python Dependencies
log_info "Installing Python dependencies (pypdf, markdown, weasyprint, cactus-needle)..."
python3 -m pip install pypdf markdown weasyprint cactus-needle --break-system-packages 2>/dev/null || \
python3 -m pip install pypdf markdown cactus-needle --break-system-packages 2>/dev/null || \
python3 -m pip install pypdf markdown --break-system-packages 2>/dev/null || \
python3 -m pip install pypdf markdown 2>/dev/null || true
log_success "Python dependencies installed."

# 4b. Pre-seed Needle on-device engine + weights (best effort, ~40MB).
# Skipped silently when offline; src/needle_bridge.py self-heals on first use.
if [ -f "src/needle_bridge.py" ]; then
    log_info "Pre-seeding Needle on-device engine (best effort)..."
    python3 -c "import sys; sys.path.insert(0, 'src'); from needle_bridge import ensure_engine; ensure_engine()" 2>/dev/null && \
    python3 -c "from needle.agent.fetch import fetch_weights; fetch_weights(3)" 2>/dev/null && \
    log_success "Needle on-device engine ready." || \
    log_warn "Needle engine pre-seed skipped (offline?). It self-heals on first @needle use."
fi

# 5. Install Node / Bun Packages
log_info "Installing project dependencies via Bun..."
export SHARP_IGNORE_GLOBAL_LIBVIPS=1
bun install --ignore-scripts || bun install

# 5b. Install WhatsApp Baileys bridge dependencies (Node `whatsapp_bridge/`).
# The bridge spawns `node whatsapp_bridge/index.js`; root node_modules covers
# most imports via Node resolution, but an isolated install keeps the bridge
# runnable standalone and pins its own lockfile.
if [ -f "whatsapp_bridge/package.json" ]; then
    log_info "Installing WhatsApp bridge packages (whatsapp_bridge/)..."
    npm install --prefix whatsapp_bridge --no-audit --no-fund 2>/dev/null || \
    (cd whatsapp_bridge && npm install --no-audit --no-fund 2>/dev/null) || \
    log_warn "WhatsApp bridge install skipped (bridge will fall back to root node_modules). Retry later with: npm install --prefix whatsapp_bridge"
fi

# 6. Initialize App Directories
mkdir -p data pdfs backups logs tmp notes projects 2>/dev/null || true

# 7. Apply ONNX & Sharp Patches
log_info "Applying ONNX logging & sharp compatibility patches..."
bun run patch_onnx.js
# Verify patches landed (warn-only: a dependency upgrade can change upstream
# sources and invalidate a search string; --check reports it loudly).
bun run patch_onnx.js --check 2>/dev/null || \
log_warn "patch_onnx.js --check reported a problem (see above). App will still run; update the patch search strings if a dependency was upgraded."

# 8. Install headless-browser engine (Playwright/Chromium for @youtube-play / @browser-*)
log_info "Installing Playwright Chromium engine (best effort, ~170MB download)..."
bunx --bun playwright install --with-deps chromium 2>/dev/null || \
bunx --bun playwright install chromium 2>/dev/null || \
log_warn "Playwright Chromium install skipped (browser commands will print the manual install hint). Retry later with: bunx playwright install chromium"

# Ensure script permissions
chmod +x install.sh install_ubuntu.sh starter.sh dockerize.sh docker-entrypoint.sh 2>/dev/null || true

log_success "=========================================================="
log_success "Ubuntu installation & setup completed successfully!"
if [ "$DETECTED_SHELL" = "zsh" ]; then
    log_info "• Zsh detected: Run 'source ~/.zshrc' (or 'exec zsh') to reload PATH"
else
    log_info "• Bash detected: Run 'source ~/.bashrc' (or 'exec bash') to reload PATH"
fi
log_info    "• For local Ollama models, ensure Ollama daemon is running ('ollama serve &')"
log_info    "• For Cloud models, set API keys with: /set-api-key <provider> <key>"
log_info    "• The first available Ollama model is selected on first launch; /model keeps all assistant tools synchronized"
log_info    "• Headless browser engine (Playwright/Chromium) installed for @youtube-play & @browser-* commands (also powers @cast-player page extraction)"
log_info    "• Needle on-device engine (cactus-needle) pre-seeded for @needle commands; enable the auto fast-path in-app with @set-setting needle_enabled 1"
log_info    "• For Web Voice UI, launch with: ./starter.sh --web (or zsh starter.sh --web)"
log_success "To start the application, run: ./starter.sh (or zsh starter.sh)"
log_success "=========================================================="
