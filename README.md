# Ollama & Multi-Provider AI Assistant Toolsuite (Bun)

An expanded, feature-rich Bun-native CLI assistant and toolsuite with local & cloud multi-provider LLM support (**Ollama**, **Google Gemini**, **Anthropic Claude**, **xAI Grok**, **OpenAI ChatGPT**), 100% offline local voice processing (**STT Speech-to-Text & TTS Text-to-Speech**), pure JavaScript Markdown/PDF conversion tools, persistent memory management, Kanban task board, custom character profiles, chat session management, agentic web tools, and **Telegram & WhatsApp Bridges**!

---

## 🚀 Key Features

* **🤖 Multi-Provider LLM Engine**:
  * **Ollama (Local)**: `llama3`, `mistral`, `qwen2.5`, `phi3`, `deepseek-r1`
  * **Google Gemini**: `gemini-2.5-flash`, `gemini-2.5-pro`, `gemini-2.0-flash`, `gemini-1.5-pro`, `gemini-1.5-flash`
  * **Anthropic Claude**: `claude-3-7-sonnet-20250219`, `claude-3-5-sonnet-20241022`, `claude-3-5-haiku-20241022`, `claude-3-opus-20240229`
  * **xAI Grok**: `grok-2-latest`, `grok-2-1212`, `grok-2-vision-1212`, `grok-beta`
  * **OpenAI ChatGPT**: `gpt-4o`, `gpt-4o-mini`, `gpt-4-turbo`, `gpt-3.5-turbo`, `o1`, `o3-mini`
  * Dynamic provider auto-routing and streaming responses.

* **🎙 100% Local STT & TTS Voice Processing (Offline)**:
  * **Speech-To-Text (STT)**: Local Whisper ONNX model (`Xenova/whisper-tiny.en`) transcribes voice attachments and audio files locally.
  * **Text-To-Speech (TTS)**: Local MMS-TTS ONNX model (`Xenova/mms-tts-eng`) synthesizes text answers into speech audio files (`.wav` / `.ogg`).
  * Automatic local voice note responses for Telegram and WhatsApp voice messages!

* **🌐 Dagowan Real-Time WebSocket Voice Bridge & Web UI ([`src/voice_socket.js`](file:///home/llama/projects/buns/llama/src/voice_socket.js))**:
  * Bun-native WebSocket server listening on `ws://127.0.0.1:8767/ws` and serving Web UI at `http://127.0.0.1:8767`.
  * Interactive Dagowan dark-mode interface with a glowing reactive voice orb & live spectrum visualizer.
  * Real-time local Whisper STT transcription, LLM query processing, and local MMS-TTS audio playback in the browser.
  * Supports "Hold to Speak" and "Continuous Duplex Voice" conversation modes.
  * Launch via CLI command `/web` (or `/voice-socket`, `/dagowan`) or launch flag `bun run index.js --web`.

* **📄 Pure JavaScript PDF & Markdown Tools**:
  * Convert Markdown notes in date ranges to PDF files using pure JS (`pdfkit` + `marked`).
  * Extract text from PDF files back into Markdown notes (`pdf-parse`).

* **✈️ Telegram Bot Integration ([`src/telegram.js`](file:///home/llama/projects/buns/llama/src/telegram.js))**:
  * Long-polling Telegram bot runner.
  * Processes incoming text and voice messages using active character profiles, memory context, and workspace notes.
  * Sends text replies and native Telegram voice note responses (`sendVoice`).

* **📱 WhatsApp HTTP Bridge ([`src/whatsapp.js`](file:///home/llama/projects/buns/llama/src/whatsapp.js))**:
  * Baileys Web Socket bridge with pairing code & QR code web viewer (`http://127.0.0.1:8766/qr`).
  * Automatic local Whisper transcription for incoming WhatsApp voice notes and native voice note replies (`ptt: true`).

* **⏱ Proactive Chat Timers & Background Check-Ins**:
  * Configurable proactive chat idle timers in minutes (`/set-proactive-timer <minutes>`).
  * Automatic background activity tracking per chat session (CLI, Telegram, WhatsApp).
  * Sends background check-ins when user has been inactive for the set idle duration.
  * Status and check interval configuration (`/proactive-status`, `/set-proactive-check <seconds>`).

* **🧠 Persistent Memory & Context Injection**:
  * Persistent memory snippets (`/remember <text>`) saved to `memory.json`.
  * Auto-refreshes active conversation context immediately upon memory updates.
  * Query-relevance search and fallback to recent memories during conversation.

* **📋 Kanban Task Board**:
  * Task statuses: Processing (`p`), Ongoing (`o`), Finished (`f`).
  * Automatic task numbering and background reminders (`/set-task-reminder`).

* **🎭 Character Profiles & System Prompts**:
  * Custom character personas in `characters.json`.
  * Configurable system prompt templates and per-character LLM models.

* **💾 Backup & Restore State**:
  * Export/import full application state, settings, memories, tasks, and sessions (`/export-settings`, `/import-settings`).

---

## 💻 Installation & Setup

### ⚡ Automated 1-Command Installers

We provide automated setup scripts for both **Android PRoot-Distro Ubuntu** and **Standard Ubuntu Desktop / Server**:

#### 📱 Android (PRoot-Distro Ubuntu in Termux)
Universal installer for all Android devices running PRoot-Distro Ubuntu. Automatically installs system packages (`ffmpeg`, `espeak`, `python3-pip`, `build-essential`), Node.js 20, Bun, Python dependencies, bypasses native C++ compilation issues on Android (`--ignore-scripts`), and applies ONNX WASM, `@napi-rs/canvas`, `pdf-parse`, and `sharp` compatibility patches ([`patch_onnx.js`](file:///root/llama/patch_onnx.js)):
```bash
chmod +x install.sh starter.sh
./install.sh
```

#### 🐧 Standard Ubuntu (Desktop / Server / VPS - 20.04 / 22.04 / 24.04 LTS)
For regular Ubuntu desktop machines, server environments, and cloud VPS instances. Automatically detects `sudo` privileges, installs system packages (`libvips-dev`, `ffmpeg`, `espeak`, `python3-pip`), Node.js 20, Bun, Python dependencies, and configures runtime patches ([`patch_onnx.js`](file:///root/llama/patch_onnx.js)):
```bash
chmod +x install_ubuntu.sh starter.sh
./install_ubuntu.sh
```

---

### 🚀 Running the Application

After running either installer script, you can start the application using the startup wrapper or directly via Bun:

```bash
./starter.sh
```
*Or manually:*
```bash
bun start
```

---

### Manual Prerequisites

If you prefer to install prerequisites manually:

1. **Bun Runtime** (v1.0 or higher)
   ```bash
   curl -fsSL https://bun.sh/install | bash
   ```
2. **FFmpeg** (Required for audio/voice conversion)
   * Linux: `sudo apt install ffmpeg`
   * macOS: `brew install ffmpeg`
3. **Ollama Daemon** (Optional, for local LLM models)
   * Install from [ollama.com](https://ollama.com) and start daemon:
   ```bash
   ollama serve
   ollama pull llama3
   ```

### 2. Configure API Keys (Optional for Cloud LLMs)

You can set provider API keys via environment variables, a `.env` file, or using slash commands inside the application.

#### Option A: `.env` file
Create a `.env` file in the root directory:
```env
OPENAI_API_KEY=sk-proj-...
GEMINI_API_KEY=AIzaSy...
CLAUDE_API_KEY=sk-ant-...
GROK_API_KEY=xai-...
```

#### Option B: In-App Slash Commands
Inside the running application:
```text
/set-api-key openai sk-proj-...
/set-api-key gemini AIzaSy...
/set-api-key claude sk-ant-...
/set-api-key grok xai-...
```

---

## 🚀 Running the Application

### 1. Start Interactive CLI Chat

```bash
bun start
```

### 2. Enable Telegram Bot Integration

Set your Telegram token and launch:
```bash
TELEGRAM_TOKEN="your_bot_token" bun start
```
*(Or save token via `/set-telegram-token <token>` inside the CLI)*

### 3. Enable Real-Time Duplex Voice Web Interface

Start CLI with real-time WebSocket voice server & web interface enabled (suppressing ONNX log notices):
```bash
bun run web
```
* **Web UI Access**: Open `http://127.0.0.1:8767` in your browser.
* **In-App Slash Command**: Type `/web` inside the running CLI.

---

## 🛠 Complete Slash Commands Reference

### 🎙 Local Voice & Audio Commands (Offline)
* `/web` (or `/voice-socket`, `/voice-server`, `/dagowan`) — Launch real-time duplex voice web interface (`http://127.0.0.1:8767`).
* `/voice <audio_file_path>` — Transcribe audio file locally (Whisper STT), process question with LLM, and synthesize response.
* `/tts <text>` — Synthesize text locally into a speech `.wav` file using local MMS-TTS model.
* `/voice-reply [on|off]` (or `/voicereply`) — Toggle automatic local voice note response generation for answers.

### 🤖 LLM Models & Multi-Provider API Keys
* `/models` — List all available models across local Ollama, OpenAI, Gemini, Claude, and Grok.
* `/model [model-name]` — View active model or switch model (e.g., `/model gemini-2.5-flash`, `/model claude-3-5-sonnet-20241022`, `/model grok-2-latest`, `/model gpt-4o`, `/model llama3`).
* `/set-api-key <provider> <api_key>` (or `/set-key <provider> <key>`) — Set API key for `openai`, `gemini`, `claude`, or `grok`.
* `/api-keys` (or `/keys`) — View status and source of configured provider API keys.

### 📄 PDF & Markdown Note Tools
* `/convert-pdf [from_date] [to_date]` (or `/pdf 2026-07 2026-08`) — Batch convert Markdown notes to PDF files in `pdfs/`.
* `/pdf-to-md <filename.pdf>` (or `/convert-md notes.pdf`) — Extract PDF text into Markdown note files in `notes/`.
* `/fetch-note-about <topic>` (or `/write-about <topic>`) — Search notes for topic and synthesize response.

### 📋 Kanban Task Management
* `/register-task <description>` (or `/task <desc>`) — Register a new task into Processing status (`p`).
* `/get-tasks` (or `/tasks`) — List active (unfinished) tasks.
* `/all-tasks` — List all tasks including finished.
* `/move-task-<id>-(p|o|f)` (or `/move-task <id> <p|o|f>`) — Move task status (**p**: processing, **o**: ongoing, **f**: finished).
* `/delete-task-<id>` (or `/delete-task <id>`) — Delete task by ID.
* `/set-task-reminder <minutes>` — Enable automatic background task reminders.
* `/stop-task-reminder` — Disable task reminders.
* `/task-reminder-status` — Show current task reminder configuration.

### ⏱ Proactive Chat & Timer Commands
* `/set-proactive-timer <minutes>` (or `/proactive-timer <mins>`) — Set proactive chat idle timer in minutes (and enable proactive chat).
* `/proactive-chat [on|off]` (or `/proactive [on|off]`) — Enable, disable, or toggle proactive chat check-ins.
* `/proactive-status` (or `/proactive-timer-status`) — View current proactive chat timer & check-in settings.
* `/stop-proactive-timer` (or `/stop-proactive`) — Disable proactive chat check-ins.
* `/set-proactive-check <seconds>` (or `/proactive-check <secs>`) — Set background check frequency in seconds (default 60s).

### 🧠 Persistent Memory Management
* `/remember <text>` — Save a persistent memory to `memory.json` (auto-refreshes active conversation context).
* `/memories` (or `/list-memories`) — List all saved memories.
* `/delete-memory <index|timestamp>` — Delete a memory entry.
* `/update-memory <index|timestamp> <new text>` — Update memory content.

### 🎭 Character Profiles & Personas
* `/character [name|id]` — View or switch active character persona profile.
* `/characters` — List available character profiles.
* `/create-character <Name> | <Model> | <Prompt>` — Create a custom character persona.
* `/set-persona-prompt <prompt>` — Set system prompt template for active character.
* `/set-telegram-token <token>` — Save Telegram bot token to character profile.
* `/whatsapp-pair <phone_number>` — Generate WhatsApp 8-digit phone pairing code.
* `/set-whatsapp-phone <phone_number>` (or `/whatsapp-number`) — Set default WhatsApp phone number.
* `/reset-whatsapp-auth` — Clear stale WhatsApp auth keys to reconnect.

### 💬 Chat Session Management
* `/sessions` — List saved conversation sessions.
* `/session <id>` — Switch to session by ID.
* `/new-session` — Start a fresh chat session.
* `/delete-session <id>` — Delete session by ID.
* `/rename-session <title>` — Rename active session.

### 💾 Backup & Settings
* `/export-settings [filename]` (or `/backup`) — Export application state, memories, tasks, and sessions to `backups/`.
* `/import-settings [filename]` (or `/restore`) — Restore application state from a backup file.
* `/list-backups` — List available backup files.

### 🔍 Search & Web Browser
* `/search-youtube-for <query>` — Search YouTube in default browser.
* `/search-google-for <query>` — Search Google in default browser.
* `/search-giphy-for <query>` — Search Giphy in default browser.
* `/open-browser` — Open system web browser.

### ℹ️ General Controls
* `/get-commands` (or `/commands`, `/help`) — Display full command manual.
* `/clear` — Clear active conversation context window.
* `exit` / `quit` — Save state and exit application.

---

## 📂 Project Structure

```
.
├── index.js                  # Main CLI entry point with interactive REPL & streaming
├── package.json              # Bun dependencies
├── app_settings.json         # Active application configuration
├── memory.json               # Memory persistence store
├── tasks.json                # Kanban tasks persistence store
├── characters.json           # Character profiles & system prompts
├── chat_sessions.json        # Chat sessions store
├── whatsapp_qr.html          # Web view for WhatsApp QR code & pairing
├── voice_interface.html      # Dagowan real-time voice web UI
├── backups/                  # Exported JSON backups
├── notes/                    # Workspace Markdown notes directory
├── pdfs/                     # Output directory for generated PDF files
├── whatsapp_bridge/          # Node.js Baileys web socket bridge for WhatsApp
└── src/
    ├── config.js             # Settings manager, export & import settings
    ├── memory.js             # Memory store & relevance search
    ├── tasks.js              # Kanban task board & reminder manager
    ├── proactive.js          # Proactive chat timers & idle check-in manager
    ├── characters.js         # Character profile manager & system prompt templates
    ├── sessions.js           # Chat sessions manager & cross-session context retrieval
    ├── workspace.js          # Workspace note file reader & relevance search
    ├── pdf_utils.js          # Pure JavaScript Markdown-to-PDF & PDF-to-Markdown tools
    ├── providers.js          # Unified Multi-Provider LLM engine (Ollama, Gemini, Claude, Grok, OpenAI)
    ├── audio.js              # 100% Local STT (Whisper) & Local TTS (MMS-TTS) audio models
    ├── voice_socket.js       # Real-Time WebSocket Voice Bridge & Server
    ├── telegram.js           # Telegram bot runner integration with voice attachment support
    ├── whatsapp.js           # WhatsApp HTTP bridge server integration
    └── commands.js           # Slash commands dispatcher & help manual
```

---

## 🔧 Troubleshooting & PRoot-Distro (Termux) Guide

### ⚠️ `LLM Error: Unable to connect. Is the computer able to access the url?`

This error occurs when the active model (or fallback model) is set to Ollama (`http://127.0.0.1:11434`), but the Ollama daemon process is not running or unreachable:

#### Option A: Running Local Ollama Models (PRoot-Distro / Termux)
1. Start the Ollama background daemon:
   ```bash
   ollama serve &
   ```
2. Download your preferred model (e.g. `llama3` or `mistral`):
   ```bash
   ollama pull llama3
   ```
3. Test connection:
   ```bash
   curl http://127.0.0.1:11434/api/tags
   ```

#### Option B: Switch to Cloud Models (Gemini / OpenAI / Claude / Grok)
If you don't want to host local heavy models in PRoot-Distro, use a cloud provider:
1. Save your API key:
   ```text
   /set-api-key gemini YOUR_GEMINI_API_KEY
   ```
2. Switch model:
   ```text
   /model gemini-2.5-flash
   ```

---

### 📱 WhatsApp & Telegram Connection Issues in PRoot-Distro

* **DNS Resolution Failure**: In PRoot-Distro, if external API calls (`api.telegram.org` or `web.whatsapp.com`) fail, verify `/etc/resolv.conf`:
  ```bash
  echo "nameserver 8.8.8.8" > /etc/resolv.conf
  ```
* **WhatsApp Session Desync**: Reset stale WhatsApp pairing keys:
  ```text
  /reset-whatsapp-auth
  ```
  Then rescan QR at `http://127.0.0.1:8766/qr` or request phone pairing code with `/whatsapp-pair <phone_number>`.

---

## 📜 License

MIT License © Andrius Pratusis

