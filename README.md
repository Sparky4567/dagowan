# Ollama & Multi-Provider AI Assistant Toolsuite (Bun)

An expanded, feature-rich Bun-native CLI assistant and toolsuite with local & cloud multi-provider LLM support (**Ollama**, **Google Gemini**, **Anthropic Claude**, **xAI Grok**, **Mistral AI**, **OpenAI ChatGPT**), 100% offline local voice processing (**STT Speech-to-Text & TTS Text-to-Speech**), pure JavaScript Markdown/PDF conversion tools, persistent memory management, Kanban task board, custom character profiles, chat session management, agentic web tools, **Telegram & WhatsApp Bridges**, **OpenWebUI-style Dashboard**, and the **Ollama CLI Autonomous Coding Engine**!

---

## 🚀 Key Features

* **🤖 Multi-Provider LLM Engine**:
  * **Ollama (Local & Offline)**: `llama3`, `mistral`, `qwen2.5`, `phi3`, `llama3.1`, `deepseek-r1`
  * **Google Gemini**: `gemini-2.5-flash`, `gemini-2.5-pro`, `gemini-2.0-flash`, `gemini-1.5-pro`, `gemini-1.5-flash`
  * **Anthropic Claude**: `claude-3-7-sonnet-20250219`, `claude-3-5-sonnet-20241022`, `claude-3-5-haiku-20241022`, `claude-3-opus-20240229`
  * **xAI Grok**: `grok-2-latest`, `grok-2-1212`, `grok-2-vision-1212`, `grok-beta`
  * **Mistral AI**: `mistral-large-latest`, `mistral-medium-latest`, `mistral-small-latest`, `codestral-latest`, `ministral-8b-latest`, `ministral-3b-latest`
  * **OpenAI ChatGPT**: `gpt-4o`, `gpt-4o-mini`, `gpt-4-turbo`, `gpt-3.5-turbo`, `o1`, `o3-mini`
  * Dynamic provider auto-routing, seamless key management, and real-time streaming responses.
  * **One shared model setting** across CLI chat, web voice, Telegram, WhatsApp, learning, BabyAGI, and coding tools. On a fresh install, the first model returned by Ollama is selected automatically; if Ollama is unavailable, the documented first local model (`llama3`) is used until changed.
  * **Ephemeral one-shot Ollama inference (default ON)**: every local-Ollama turn shells out to the bun-ollama CLI (`bun run <ollama-lite>/src/index.ts run <model> --messages-json '<msgs>'` with the model read from settings and full role-labeled history preserved), answers once, then unloads the model so RAM is freed immediately — no persistent `llama-server` between turns. Toggle on any surface with `@ephemeral [on|off|status]` (or `@set-setting ollama_ephemeral 0` for the persistent `server_url` daemon). One-shot CLI: `bun run ask "Why is the sky blue?"` (uses `settings.model`; `--model <name>` overrides).

* **🎙 100% Local STT & TTS Voice Processing (Offline)**:
  * **Speech-To-Text (STT)**: Local Whisper ONNX model (`Xenova/whisper-tiny.en`) transcribes voice attachments and audio files locally.
  * **Text-To-Speech (TTS)**: Local MMS-TTS ONNX model (`Xenova/mms-tts-eng`) synthesizes text answers into speech audio files (`.wav` / `.ogg`).
  * Automatic local voice note responses for Telegram and WhatsApp voice messages!

* **🌐 Dagowan Real-Time WebSocket Voice Bridge & Web UI (`src/voice_socket.js`)**:
  * Bun-native WebSocket server listening on `ws://127.0.0.1:8767/ws` and serving Web UI at `http://127.0.0.1:8767`.
  * Interactive Dagowan dark-mode interface with a glowing reactive voice orb & live audio spectrum visualizer.
  * Real-time local Whisper STT transcription, LLM query processing, and local MMS-TTS audio playback in the browser.
  * Supports "Hold to Speak" and "Continuous Duplex Voice" conversation modes.
  * **Security panel (🔒 header button):** PIN + OTP locks/unlocks on the shared `web` scope — `@security-status` / `@otp-status` status checks, `@unlock <pin>` / `@lock`, `@set-security-pin` / `@remove-security-pin`, `@otp-set` / `@otp-login <code>` / `@otp-lock` / `@otp-remove <code>`, unlock TTL (`security_unlock_minutes`, also editable in Engine Settings). All lock/unlock/info messages are generated dynamically from the live `security_unlock_minutes` value (e.g. `@help`, `@security-status`, `@otp-status`, locked replies) — no hard-coded durations. Header lock badge (🔒/🔓) updates from server replies; status is auto-queried on connect.
  * **Commands browser (📜 header button):** searchable list of all supported `@` commands (security, OTP, models, memory, tasks, coding, MCP, search, cast, voice, …) with one-click ▶ Send, plus `@help` (the manual itself is lock-gated like any control command). The `@unlock` entry shows the live `security_unlock_minutes` value and refreshes whenever settings sync.
  * **Full `@` command execution:** the Web bridge dispatches the same tool commands as Telegram/WhatsApp — `@make`, `@create-file`, `@youtube-play`/`@play`, `@spotify-play`, `@blog`, `@fact-check`, `@web-search`/`@web-fetch`/`@web-status`, `@browser-*`, `@cast-*`, `@voice-reply`, PDF tools, backup/restore, `@remember`, tasks, `@stats`, `@models`, `@sessions` (plus natural blog publish intents) — so the Web UI and the Chrome side panel actually run tools instead of chatting about them. Command replies are text-only (no TTS) and lock-gated like everywhere else.
  * Mobile-responsive layout (`voice_interface.html` media queries at 640px/380px: stacked header, scaled orb, viewport-height transcript, full-width 44px touch controls, 16px input to prevent iOS auto-zoom) — the same full-duplex UI on phones and desktops.
  * Follow-up prompts never stall: turns run concurrently with turn-scoped interruption (an interrupt only cancels turns already in flight, never the next prompt), a superseded turn skips its TTS synthesis instead of blocking the next answer, and any turn failure delivers a visible error reply instead of leaving the orb stuck in "thinking". When Browser TTS is selected, the server skips its own synthesis entirely — the reply text arrives immediately and speech is rendered client-side.
  * Launch via CLI command `@web` (or `@voice-socket`, `@dagowan`) or launch flag `./starter.sh --web` (or `bun run web`).

* **🧩 Chrome Extension Companion (`chrome-extension/`)**:
  * Unpacked MV3 sidebar widget (v1.1.1) talking to the same local bridge (`ws://127.0.0.1:8767/ws`, configurable) — chat, lock/unlock, OTP, and quick `@` commands without opening the voice tab. The Web bridge dispatches the full Telegram/WhatsApp command set (`@youtube-play`, `@spotify-play`, `@blog`, `@fact-check`, `@web-search`, `@web-fetch`, `@web-status`, `@browser-*`, `@cast-*`, `@make`, `@create-file`, `@remember`, tasks, `@stats`, `@models`, `@sessions`, …), so panel commands actually execute. Inline `@web` in a sentence triggers a live search with results injected into the answer. Header lock badge (🔒/🔓) tracks PIN/OTP state from server replies. Shares the `web` scope, so its lock state matches the Web UI. Toolbar click opens the side panel (popup fallback on older Chrome).
  * Right-click any selected text → *Ask Dagowan about selection* (context menu stashes it; the side panel opens and auto-sends).
  * Install: `./starter.sh --web`, then `chrome://extensions` → Developer mode → Load unpacked → `chrome-extension/`. See `chrome-extension/README.md`.

* **🛠 Ollama CLI Autonomous Coding Engine (`ollama_cli/` & `src/ollama_coding.js`)**:
  * Integrated high-performance local AI coding agent toolset built with Bun and Ollama.
  * **`@make <prompt>`**: Autonomously executes multi-step project generation workflows using file tools (`read_file`, `write_file`, `list_directory`, `search_files`) and host shell execution (`run_command`) in the configured project path.
  * **`@create-file <file_path> [content|prompt]`**: Fast direct file creation or LLM file generation with automatic recursive parent directory creation.
  * **`@opencli <task>`**: API-driven OpenAI coding agent — runs a real tool loop (`read_file`, `write_file`, `list_directory`, `search_files`, `run_command`) against the OpenAI API, jailed to the project path. Needs `OPENAI_API_KEY` (`@set-api-key openai <key>`); remote surfaces (Telegram/WhatsApp) are owner-gated via `opencli_allowed_chats`. CLI/Web UI count as local. Every tool call is audit-logged to `logs/opencli.log`.
  * **`@opencode <task>`**: external `opencode` CLI runner — needs `@set-project-path <dir>` first (no default) and a model via `@opencode-model <provider/model>` or opencode's own `opencode.json` (no hardcoded default). Owner-gated remotely via `opencode_allowed_chats`; audit-logged to `logs/opencode.log`. First-time setup on any surface: `@opencode-setup` (checks binary/auth/path/model/permissions with fix commands, ends with an end-to-end test probe) + `@opencode-setup-auto-allow [full|safe|review]` (writes hands-free file permissions into `<projectDir>/opencode.json`). Sends a `RUNNING: "<task>"` start message immediately (project/model included) and a `FINISHED successfully (<s>)` / `FAILED` message with timing when opencode exits — on CLI, Telegram, and Web UI as two messages; on WhatsApp `/chat` (single-reply) as one enriched `FINISHED` message with the start logged server-side.
  * **`@change-project-path <path>` (or `@project-path`)**: Configure and persist custom project output folders (stored in `app_settings.json` and `~/.ollama_cli.json`).
  * Standalone CLI support (`ollama_cli/`) with `-p, --project-path` flag and interactive REPL commands.
  * Native support across CLI sessions, Telegram Bot, and WhatsApp Bridge.

* **🌐 API-first playback + blog drafts + fact-check + Chromium fallback (`src/play_api.js`, `src/blog_api.js`, `src/factcheck_api.js`, `src/browser.js`)**:
  * **`@fact-check <claim> [--limit N] [--source auto|papers|gemini]` (or `@factcheck`, `@verify`)**: Searches Semantic Scholar for papers (title, abstract, year, citation count, DOI, open-access PDF) to verify a claim. Anonymous access works (~100 requests / 5 min); a free API key (`SEMANTIC_SCHOLAR_API_KEY`, private 1 req/sec) raises limits. With `GEMINI_API_KEY` set, a Gemini verdict (SUPPORTED / REFUTED / MIXED / UNVERIFIABLE) is added on top of the abstracts, or standalone via `--source gemini` / `FACTCHECK_SOURCE`.
  * **`@youtube-play <query|URL>` (or `@play`)**: Official YouTube Data API v3 by default (`YOUTUBE_API_KEY`), hands the top video to your system default browser (`--no-show` skips the handoff). Playwright/Chromium automation is the fallback.
  * **`@spotify-play <query|URL>` (or `@spotify`)**: Official Spotify Web API by default (`SPOTIFY_CLIENT_ID`/`SPOTIFY_CLIENT_SECRET`), hands the top track/episode to your default browser / Spotify app. Chromium automation is the fallback.
  * **`@blog <topic>` (or `@wordpress`, `@blogger`, `@post`)**: The active LLM writes a complete post (350-550 words HTML; starter template only if the model is unreachable), then the official WordPress REST / Blogger v3 APIs create a real draft (`WORDPRESS_SITE_URL`/`USERNAME`/`APP_PASSWORD`, `BLOGGER_BLOG_ID`/`ACCESS_TOKEN`, or `@blogger-auth` OAuth) and hand the editor to your default browser. Chromium editor automation is the fallback. Natural callout also works: `@Parsly, write a blog post about <topic> on @wordpress` (or `on @blogger`).
  * **`@browser-search` / `@browser-search-spotify` / `@browser-open` / `@browser-read` / `@browser-shot` / `@browser-status` / `@browser-close`**: Full page interaction toolkit, identical on CLI, Telegram, WhatsApp, and Web UI.
  * Same tools exposed to the Ollama CLI agent loop (`browser_open`, `browser_search_youtube`, `browser_play_youtube`, `browser_search_spotify`, `browser_play_spotify`, `browser_draft_blog`, `fact_check_papers`, `browser_read`, `browser_screenshot`).
  * Safety rails: domain allowlist, auto headless fallback on display-less machines (`BROWSER_HEADLESS` override), audit log in `logs/browser.log`.

* **🌐 Live web search (`src/websearch.js` + `src/mcp_web_server.js`, zero new dependencies)**:
  * Mention **`@live-web` anywhere in a sentence** (`latest BTC price @live-web`) and the turn runs a real-time search whose results are injected as system context — so **every** provider (local Ollama + OpenAI/Gemini/Claude/Grok/Mistral cloud models) answers with current facts and `[1]`, `[2]` citations. Works on CLI, Telegram, WhatsApp, Web UI, and the Chrome side panel; works while PIN/OTP-locked (mid-sentence `@live-web` is chat, not a control command). (`@web` stays the voice-bridge toggle.)
  * Mention **`@live-gemini` anywhere in a sentence** (`explain black holes @live-gemini`) for Google AI Mode: Gemini API `google_search` grounding when `GEMINI_API_KEY` is set (AI answer + cited sources), else best-effort keyless Google scrape (`google.com/search?udm=50`), else DuckDuckGo fallback. Same inline/explicit/session rules as `@live-web`.
  * **Engines** (`auto` default): Brave Search API → Tavily → keyless DuckDuckGo fallback (Instant Answer abstract + HTML results merged, deduped). Explicit `@live-web <query>` / `@live-gemini <query>` / `@web-search <query> [--provider auto|duckduckgo|brave|tavily|google-ai] [--limit N]`, `@web-fetch <url>` (page → plain text), `@web-status`.
  * **MCP pair**: built-in `web` server (`web__web_search` / `web__web_fetch`) auto-registered next to `local`; keys via `@set-api-key brave|tavily|gemini <key>` (or `BRAVE_API_KEY` / `TAVILY_API_KEY` / `GEMINI_API_KEY`). Settings: `websearch_enabled` (default on), `websearch_provider`, `websearch_max_results` (1–10, default 5), `websearch_timeout_ms`, `gemini_search_model` (default `gemini-2.5-flash`). Unit-tested (`src/websearch.test.js`, mocked fetch — no network).

* **🪡 Needle On-Device Tool Calling (`src/needle.js` + `src/needle_bridge.py`)**:
  * Cactus Needle (8-29 MB automation model, `pip install cactus-needle`) for grammar-constrained tool routing, typed extraction, and local embeddings — fully offline after the one-time weight download.
  * **`@needle <request>`**: routes to a local tool (`remember_memory`, `register_task`, `save_note`, `set_proactive_timer`) with a calibrated confidence score; executes only at/above `needle_min_confidence` (default 0.7), shows below-threshold calls for confirmation, and refuses off-topic input with an empty call list.
  * **Automatic fast-path** (`needle_enabled=1`, off by default): plain chat turns on CLI / Telegram / WhatsApp / voice that Needle confidently owns are executed locally without waking the main LLM — saving a full LLM roundtrip per local-action turn. Cheap keyword pre-filter → warm daemon route (~4-9 s CPU, ~23 s one-time cold start) → confidence gate → shared executor; refusals and low-confidence turns fall through to the normal LLM flow untouched. The daemon idles out after `needle_daemon_idle_ms` (default 5 min, frees ~150 MB).
  * **`@needle-extract <JSON schema> <text>`**, **`@needle-embed <text>`**, **`@needle-tools`**, **`@needle-status`**: typed extraction without a large LLM, embedding debugging, catalog and install/model/threshold/daemon status.
  * **Learning triage**: background LLM extraction now skips trivial <3-word turns (one saved LLM call per chitchat turn; the synchronous heuristic pass still runs).
  * Self-healing engine fetch: works around upstream wheel-version skew (e.g. package 3.0.5 vs published 3.0.0/3.0.1 engines) by seeding the newest compatible wheel.
  * Setup: `pip install cactus-needle` (already covered by `install.sh` / `install_ubuntu.sh` / `Dockerfile`, which also pre-seed the engine + weights best-effort), then in-app:
    ```text
    @needle-status                        # verify install / model / daemon state
    @needle remember that I prefer tea    # one-shot on-device routing
    @set-setting needle_enabled 1         # automatic fast-path on every surface
    ```
  * Settings: `needle_enabled`, `needle_min_confidence`, `needle_model_path` (custom `.cact`), `needle_python`, `needle_daemon_idle_ms`.

* **🔌 MCP (Model Context Protocol) Servers (`src/mcp.js`, zero new dependencies)**:
  * Speaks MCP stdio (newline-delimited JSON-RPC: `initialize` → `tools/list` → `tools/call`) against any Claude-format `mcp_servers.json` (`{ "mcpServers": { "<name>": { "command": ..., "args": [...], "env": {...}, "disabled": true } } }`).
  * **Works on first run**: no config file yet → `@mcp-status` (or any MCP use) auto-creates `mcp_servers.json` with the built-in `local` server (`src/mcp_local_server.js` via Bun — offline `ping` / `read_file` / `list_directory`, paths jailed to the working directory) **plus** the built-in `web` server (`src/mcp_web_server.js` via Bun — live `web_search` / `web_fetch`: Brave/Tavily with keys, keyless DuckDuckGo fallback). Existing configs are migrated (missing `web` entry added, custom entries untouched). Enabled by default (`mcp_enabled: true`); `npx`-based examples in `mcp_servers.example.json` stay disabled.
  * **Agent integration**: `@make` / `@create-file` coding agent merges MCP tools (`<server>__<tool>`) with built-ins each turn and routes calls through the manager (`ollama_cli/src/agent.ts`); `@mcp-call <server__tool> [json_args]` calls any tool manually from CLI / Telegram / WhatsApp.
  * **`@mcp-status` / `@mcp-list` / `@mcp-tools [server]` / `@mcp-reconnect [server]` / `@mcp-enable|disable <server>`** plus settings `mcp_enabled`, `mcp_config_path`, `mcp_timeout_ms` (default 15 s for cold `npx` starts). Connections lazy-spawn, handshake once, idle-cleaned on `@mcp-reconnect` and process exit. Unit-tested (`src/mcp.test.js`, incl. a real stdio roundtrip — no network).

* **📺 TV Cast, Castor-style (`src/cast/`, Bun-only, no new dependencies)**:
  * Casts direct video URLs, HLS/DASH playlists, and web pages with embedded video to DLNA/UPnP smart TVs **and** Chromecast / Android TV — from CLI, Telegram, WhatsApp, and Web UI with one shared parser.
  * **`@cast-scan`** lists DLNA renderers (SSDP multicast) + Chromecasts (mDNS `_googlecast` + DIAL SSDP) merged by IP; **`@cast <url>`** auto-routes (direct file → as-is, page → headless-Chromium stream extraction, YouTube URL → native YouTube app on Chromecast via DIAL); **`@cast-url` / `@cast-player` / `@cast-pause` / `@cast-play` / `@cast-status` / `@cast-stop`** cover the rest.
  * The TV pulls from a local `Bun.serve()` relay: byte-proxy with `Range` support for MP4/MKV, per-request ffmpeg MPEG-TS pipe for HLS/MPD on DLNA, native playlist passthrough on Chromecast. `ffprobe` decides direct vs transcode; no DRM (same limit as Castor).
  * **`@set-cast-device <name|ip|description-url>`** selects/pins the target (IP pin uses unicast, so it works across VLANs/Termux where multicast is blocked); `@set-setting cast_device_type <auto|dlna|chromecast>` forces a protocol.
  * Needs any recent `ffmpeg`/`ffprobe` on `PATH` (only basic encode/probe flags are used) and Chromium (`bunx playwright install chromium`) for page extraction; machine and TV must share a LAN (no guest-WiFi isolation). Unit-tested (`src/cast/cast.test.js`, `src/cast/chromecast.test.js`, no network needed).

* **📄 Pure JavaScript PDF & Markdown Tools**:
  * Convert Markdown notes in date ranges to PDF files using pure JS (`pdfkit` + `marked`).
  * Extract text from PDF files back into Markdown notes (`pdf-parse`).

* **🔒 Security PIN + 🔐 OTP 2FA (`src/security.js` + `src/otp.js`)**:
  * `@set-security-pin <6+ digits>` sets a PIN that locks **all** `@` control commands on CLI, Telegram, WhatsApp, and Web UI until `@unlock <pin>` (per-chat unlocks on Telegram/WhatsApp, expiring after `security_unlock_minutes`, default 10; `@lock` re-locks, `@security-status` inspects, `@remove-security-pin` clears). Every lock/unlock/status/info message is rendered dynamically from the live `security_unlock_minutes` setting (`src/security.js`: `formatUnlockDuration()` / `unlockDurationInfo()`; `@help` via `buildCommandsHelp(settings)` in `src/commands.js`, wired into all four surfaces) — changing the setting immediately changes the wording everywhere, including the Web commands browser.
  * `@otp-set` enrolls TOTP 2FA (Google Authenticator / Authy / 1Password — dependency-free RFC 6238, SHA-1, 30s, 6 digits). While enrolled, the OTP layer sits **before** `@unlock`: every surface needs `@otp-login <code>` first (per-chat logins on Telegram/WhatsApp, same TTL; `@otp-lock` drops, `@otp-status` inspects, `@otp-remove <code>` clears and requires **both** OTP auth and PIN unlock).
  * Regular chatting — including `@Name` persona mentions — always works without the PIN/OTP. The PIN is stored only as a salted SHA-256 hash and the OTP secret (`otp_secret` in `app_settings.json`, manageable only via `@otp-*`) is never displayed; auth state is in-memory, so a restart always re-locks. Unit-tested (`src/security.test.js`, `src/otp.test.js`).

* **✈️ Telegram Bot Integration (`src/telegram.js` + `src/persona_bridge.js`)**:
  * Long-polling Telegram bot runner.
  * **On-demand persona polling**: on boot only the ACTIVE persona polls Telegram. Other personas wake on explicit request (`@character` switch, `@wake <name>`, `@Name ...` mention routing in CLI/WhatsApp, any Telegram/WhatsApp activity) and auto-sleep after `persona_idle_timeout_minutes` (default 15, active persona never sleeps). Idle sweep runs every `persona_polling_sweep_seconds` (default 60). Disable with `persona_polling_on_demand: false` in `app_settings.json` to poll all personas at once (legacy behavior).
  * **Single-poller guarantees**: one token is never polled by two loops at once — concurrent wakes are serialized, double-`start()` is rejected, `stop()` aborts the in-flight `getUpdates`, `@character` switches migrate the shared fallback-token runner instead of duplicating it, and duplicate pollers stop themselves on Telegram's 409 conflict instead of retrying. Rate limits (429) are honored via `retry_after` with exponential backoff, and delivered `update_id`s are deduped so overlaps never double-reply.
  * Processes incoming text and voice messages using active character profiles, memory context, and workspace notes.
  * Sends text replies and native Telegram voice note responses (`sendVoice`).

* **📱 WhatsApp HTTP Bridge (`src/whatsapp.js`)**:
  * Baileys Web Socket bridge with pairing code & QR code web viewer (`http://127.0.0.1:8766/qr`, port honors `WHATSAPP_STATUS_PORT`).
  * **No duplicate work**: only live (`notify`) deliveries are answered — history replays on reconnect are ignored — and redelivered stanzas are deduped, so one message never triggers concurrent LLM calls or double replies.
  * **Serialized replies per chat**: concurrent deliveries for the same JID are queued (in-order replies, no interleaved session saves); different chats still process in parallel.
  * Automatic local Whisper transcription for incoming WhatsApp voice notes and native voice note replies (`ptt: true`).
  * **Group `@character-name` callouts**: in group chats each persona responds only when explicitly mentioned (e.g. `@Parsly what do you think?`). Mention several characters and each one replies in turn (`@Whiskers and @Parsly discuss this`). Matching is case-insensitive and `_`/`-`/spaces are equivalent (`@Obi Wan` == `@Obi_Wan` == `@ObiWan`); multi-word names also answer to their first word (`@Dungeon` → Dungeon master). 1:1 DMs with an `@character-name` mention reply as the mentioned persona (otherwise as the active character), and `@` bot commands (`@help`, `@wake`, `@play`, `@blog`, `@fact-check`, … — the full server command list) always bypass the gate. Disable with `whatsapp_mention_only_groups: false` in `app_settings.json` (or `WHATSAPP_MENTION_ONLY_GROUPS=0`); related toggles `whatsapp_strip_mention` / `whatsapp_mention_prefix` (env `WHATSAPP_STRIP_MENTION` / `WHATSAPP_MENTION_PREFIX`).
  * Examples: DM `@Whiskers what do you think?` → answered by Whiskers; DM `hello` → answered by the active character; group `@Whiskers and @Parsly discuss this` → one reply per tagged persona.
  * **Self-healing socket process**: the Baileys bridge auto-restarts with backoff after crashes (no more silent WhatsApp death); `stop()` escalates SIGTERM → SIGKILL so stale sockets never compete with the next launch. Optional `/chat` auth via `WHATSAPP_BRIDGE_TOKEN` (set on both processes; unset keeps loopback trust) plus a 2 MB payload cap.

* **⏱ Proactive Chat Timers & Background Check-Ins**:
  * Configurable proactive chat idle timers in minutes (`@set-proactive-timer <minutes>`).
  * Automatic background activity tracking per chat session (CLI, Telegram, WhatsApp).
  * Sends background check-ins when user has been inactive for the set idle duration.
  * Status and check interval configuration (`@proactive-status`, `@set-proactive-check <seconds>`).

* **🧠 Incremental Learning & Persistent Memory Storage (Eliza Cognitive Layer)**:
  * **Dual-Tier Storage Architecture**: Backed by high-performance SQLite (`data/bot.db`) with automatic two-way synchronization to `memory.json`.
  * **Per-Character Private Memory Pools**: Every character persona owns its own memories via `memories.character_id` (`src/memory.js`, `src/db/schema.js`). Retrieval, learning extraction, `@remember`/`@correct`/`@forget`/`@update-memory`, and CLI/Telegram/WhatsApp/voice context injection are all scoped to the active character (plus legacy `shared` entries). `@memories`/`@memories-all` show an `[owner]` tag per entry, and `@stats` breaks counts down by character — one bot can no longer see another bot's private pool.
  * **Multilanguage Memory Layer (no fixed language list)**: Every memory is auto-tagged with its turn language (`memories.language`, `src/language.js`) — any ISO 639 code the model supports gets its own pool and per-language file (`memory.json` + `memory.lt.json`, `memory.en.json`, `memory.ja.json`, …) with zero configuration. Each turn auto-detects its language (Unicode-script routing for Japanese/Korean/Chinese/Arabic/Hebrew/Thai/Hindi/Greek/…, stopword tables for Latin-script languages, Ukrainian split from Russian) and recalls from its own pool + shared first. High-value cross-language hits surface through an offline keyword bridge (English pivots, importance-gated, score-penalised, labelled `[via en memory — translated association]`), so pools stay isolated yet associated — `@memories` shows a `[lang]` tag per entry, `@memory-langs`/`@stats` break counts down by language, and the model always replies in the user's active language.
  * **Per-Character Chat History**: Sessions already store `character_id` (`chat_sessions.json`, `src/sessions.js`); cross-session past-context lookup (`retrieveSessionContext`) is now filtered by character, and session save/rename/delete enforce ownership.
  * **Structured Typed Memories**: Tracks memories with explicit types (`fact`, `preference`, `goal`, `project`, `concept`, `relationship`, `instruction`, `correction`, `observation`), confidence levels, importance scores, tags, and lifecycle statuses (`active`, `superseded`, `forgotten`).
  * **Conflict Resolution & Automatic Superseding**: Automatically detects contradictions and topic updates, marking superseded memories when facts, preferences, or tools change.
  * **Versioned Structured Knowledge Base (`src/knowledge.js`)**: Stores modular concepts, definitions, and procedures with semantic versioning (`v1`, `v2`, ...), change reasons, and audit trails.
  * **TF-IDF & Token Relevance Search**: Advanced ranking with inverse document frequency, importance/confidence boosts, correction priority weighting, and title match boosts.
  * **Background Continuous Learning Pipeline (`src/learning.js`)**:
    * **Instant Deterministic Heuristics**: Captures explicit corrections ("Actually, I changed it..."), projects ("I am building..."), preferences ("I prefer..."), and goals in real-time.
    * **Asynchronous Deep LLM Extraction**: Deep post-turn extraction analyzing conversations to discover durable facts, structured knowledge, and explicit corrections without latency overhead. LLM replies are parsed tolerantly (`safeParseLlmJson`): strips ```json fences, uses balanced-brace extraction, and auto-repairs `1.` → `1.0`, `.8` → `0.8`, and trailing commas — so malformed numbers no longer drop the turn as `extraction_error`.
    * **Candidate Rule Proposals & Response Quality Evaluator**: Monitors conversational strategies and proposes deterministic patterns.

* **📋 Kanban Task Board**:
  * Task statuses: Processing (`p`), Ongoing (`o`), Finished (`f`).
  * Automatic task numbering and background reminders (`@set-task-reminder`).

* **🍼 Integrated BabyAGI Autonomous Planning**:
  * A Bun-native classic BabyAGI loop with task execution, task creation, prioritization, and retrieval of prior task results from SQLite-backed vector memory.
  * Uses the assistant's selected provider and model, so it works with local Ollama or configured OpenAI, Gemini, Claude, Grok, and Mistral models.
  * Persists its function registry, execution history, and task context in `data/babyagi.sqlite`.

* **⚡ Memoisation for Expensive Pure Tasks (`src/utils/memoize.js`)**:
  * Generic `memoize` (sync) + `memoizeAsync` (dedupes in-flight promises, drops rejections) with `JSON.stringify` keying, bounded LRU eviction, optional TTL, and `.clear()/.delete()/.stats`.
  * Applied to pure hot paths only: `tokenize` (`memory.js`/`knowledge.js`), provider string helpers (`providers.js`), per-turn regex gates (`needle.js`: `isNeedleFastPathCandidate`/`isTrivialTurn`), task parsers (`tasks.js`), `parseDate` (`pdf_utils.js`).
  * LLM / network / DB / filesystem writes are deliberately never memoized.

* **🧵 Threading for CPU-Bound Batch Work (`node:worker_threads`)**:
  * DB/file reads stay on the main thread (`bun:sqlite` handles are not transferable); only scoring/rendering fans out.
  * `src/utils/concurrency.js`: `availableParallelism()` / `chunkArray()` / `mapWithConcurrency()` / `getOptimalWorkerCount()` (CPU-bounded pool sizing).
  * `src/utils/retrieval_worker.js` + `src/utils/parallel_retrieval.js`: TF-IDF/word-overlap scoring for memories/knowledge/sessions runs in workers above thresholds (100/100/300 docs), sync fallback below or on worker failure. `MemoryRetriever.searchParallel`, `KnowledgeRetriever.searchParallel`, `retrieveSessionContextParallel`.
  * `src/chat_context.js`: `retrieveChatContextParallel()` resolves memories + knowledge + past sessions concurrently via `Promise.all`; wired into `index.js` chat loop with sync fallback.
  * `src/utils/pdf_worker.js` + `src/utils/pdf_parallel.js`: per-note Markdown→PDF renders and `pdf-parse` extracts run in parallel workers (`convertNotesToPdf(..., { useWorkers, concurrency })`, `convertPdfToMd(..., { useWorkers })`, `convertPdfsToMdBatch()`); merged batch PDF stays single-threaded.
  * Deliberately not threaded: memoized microsecond string helpers, single LLM `unifiedChat` calls, SQLite writes, session JSON saves.

* **🎭 Character Profiles & System Prompts**:
  * Custom character personas in `characters.json`.
  * Configurable system prompt templates and per-character LLM models.
  * Persona templates control tone and emotion (warmth, humor, expressiveness) plus per-character `temperature` — this is what makes a bot feel emotional, not the Needle tool-router (which only picks local tools and never writes replies).
  * Each persona gets a private memory pool and private chat sessions (shared/legacy memories stay visible to all; ownership is shown as `[owner]` in `@memories`).

* **🎭 Simulation Mode (simple separate chats, same persona)**:
  * Start with `@simulation <name> [optional note]`, end with `@simulation-end` (or `@simulation-stop`, `@simulation-passed`, `@simulation-pass`, `@simulation end|stop|passed`).
  * Each simulation is just normal chat with the active persona and owns its own archive file in `data/simulations/<name>.json` (chats + memories stay separate from the global memory DB).
  * While idle, relevant past-simulation entries are recalled automatically when the prompt matches (`@simulation-search <query>` for manual search). Full transcript review via `@simulation-review <name>`. Works on CLI, Telegram, WhatsApp, and web voice.

* **🪞 Daily Self-Reflections (`src/reflections.js`, separate bank in `data/reflections.json`)**:
  * Run `@insight [optional focus]` and the active LLM writes today's reflection (3-6 bullets: what mattered, what it learned about the user, what to remember tomorrow, one thing to improve) — one entry per character per day (re-running the same day refreshes it). Falls back to a deterministic template when the LLM is unreachable, so the command never fails silently.
  * Manage with `@insights [N]` (or `@insight-list`), `@insight-search <query>`, `@insight-show <id|YYYY-MM-DD>`, `@insight-delete <id|YYYY-MM-DD>`, `@insight-status`. Per-character scoped like memories; unit-tested in `src/reflections.test.js`.
  * Later turns recall relevant reflections by association and inject them as `[Relevant Self-Reflections]` alongside memories/knowledge/sessions (`src/chat_context.js` + all chat pipelines), deepening existing knowledge over time.
  * Lock-gated like any control command: needs `@otp-login` (+ `@unlock <pin>` when a PIN is set) on CLI, Telegram, WhatsApp, Web UI/voice, Dashboard, and Chrome side panel (via the shared Web bridge); regular chatting always works while locked.

* **💾 Backup & Restore State**:
  * Export/import full application state, settings, memories, tasks, sessions, and simulations (`@export-settings`, `@import-settings`).

---

## 💻 Cross-Platform Installation & Setup

The repository includes universal self-healing installation scripts and runtime patches (`patch_onnx.js`) designed to run on the **majority of devices, shells, and operating systems out of the box** (Full support for **Zsh** and **Bash** on macOS, Ubuntu, Debian, Arch Linux, Fedora, Android Termux / PRoot-Distro, VPS, and Cloud VMs).

### ⚡ 1. Automated Universal Installation (Zsh & Bash Compatible)

Run the universal installer (`install.sh`), which automatically detects your shell (**Zsh** or **Bash**), package manager, sets up system tools, installs Node.js & Bun, configures shell profiles (`~/.zshrc`, `~/.zprofile`, `~/.bashrc`), installs dependencies (root `bun install` + isolated `npm install --prefix whatsapp_bridge` for the Baileys bridge + Python packages incl. `cactus-needle` for on-device `@needle` routing, with best-effort engine/weights pre-seed), and applies runtime patches:

```bash
# Set executable permissions
chmod +x install.sh starter.sh

# Run installer (supports direct execution, Zsh, or Bash)
./install.sh
# or explicitly using Zsh:
zsh install.sh
# or using Bash:
bash install.sh
```

> **Tip for Zsh Users (macOS / Linux):** After installation, reload your shell profile to ensure Bun and Node are available in your current terminal:
> ```zsh
> source ~/.zshrc   # or: exec zsh
> ```

#### Supported Operating Systems & Package Managers:
* **macOS (Apple Silicon M-series & Intel)**: Native Zsh & Bash support, automatic Homebrew path detection (`/opt/homebrew/bin` & `/usr/local/bin`), and audio/system tool setup.
* **Ubuntu & Debian (Desktop / Server / VPS - 20.04, 22.04, 24.04 LTS)**: Automatically detects `sudo` privileges, installs `libvips-dev`, `ffmpeg`, `espeak`, Python tools, Node.js 20, and Bun. *(A dedicated `./install_ubuntu.sh` or `zsh install_ubuntu.sh` is also available).*
* **Android (PRoot-Distro Ubuntu / Debian / Termux)**: Installs APT packages, Node.js 20, Bun runtime, avoids native gyp compilation hurdles (`--ignore-scripts`), and applies ONNX WASM & Sharp fallbacks.
* **Arch Linux / Manjaro**: Detects `pacman` and installs required build and runtime dependencies.
* **Fedora / RHEL / CentOS**: Detects `dnf` and configures necessary dependencies.
* **Windows 10/11 (native)**: Every `.sh` script has a tested `.bat` twin (see below) — no WSL required.

#### Windows 10/11 (native `.bat` scripts)

Each shell script ships with a Windows batch equivalent (same name, `.bat` extension). The `.sh` files are untouched and still used on Unix; the `.bat` files are verified working on Windows (Bun 1.4 + Node 24 + Python 3.13).

```cmd
install.bat        :: full setup: winget deps (Git, Node 20, Python, ffmpeg),
                   :: Bun check, pip packages, bun install, WhatsApp bridge deps,
                   :: ONNX/sharp patches, Playwright Chromium
starter.bat        :: launch the app (same flags: --web, --whatsapp)
update.bat         :: fetch + pull --rebase origin main (refuses mid-rebase/merge,
                   :: detached HEAD; prints rebase recovery steps on conflict)
git.bat            :: stage + timestamped commit + pull --rebase + push
                   :: (same guards + conflict-marker / JSON validation)
dockerize.bat      :: docker build/run/up/down/logs/shell/clean (needs Docker Desktop)
install_ubuntu.bat :: WSL wrapper that runs install_ubuntu.sh inside Ubuntu
docker-entrypoint.bat :: Windows-side equivalent of docker-entrypoint.sh
```

```cmd
install.bat
starter.bat --web
```

Notes:
* `install.bat` installs missing tools via `winget` when available, otherwise prints manual install links. A fresh terminal picks up `ffmpeg` on `PATH` (the installer also wires it for the current session).
* The WhatsApp bridge's `git+ssh` dependency is refused by newer `npm` (`EALLOWGIT`), so the scripts fall back to `bun install --cwd whatsapp_bridge` (this creates `whatsapp_bridge/bun.lock`, untracked).
* `git.bat` is named like the tool itself: inside this folder plain `git` would re-invoke the script, so it (and `update.bat`) call `git.exe` explicitly — do the same in your own commands here.

---

### 🔧 1b. Installable node_modules patches (`patch_onnx.js`)

`node_modules/` is gitignored, so hand-edits there vanish on every fresh install. All runtime patches live as code in `patch_onnx.js` (single source of truth) and are re-applied automatically on every install path (`postinstall`, `install.sh` / `install_ubuntu.sh`, `starter.sh`, Docker build + entrypoint). Re-runs are idempotent and never stack duplicates.

What it patches and why:
* `@xenova/transformers` dist + `onnxruntime-node` backend — silence verbose ONNX logging, prefer the WASM backend under Bun.
* `@xenova/transformers` image utils / onnx backend — optional `sharp` import and `onnxruntime-web` backend so Termux / PRoot / ARM machines without native binaries still run.
* `sharp` — fallback stub when the native libvips binary is missing.
* `pdf-parse`, `@napi-rs/canvas` — suppress canvas polyfill warnings and tolerate missing native bindings under Bun.

```bash
bun run patch          # (re-)apply patches
bun run patch:check    # read-only verify; exits 1 if a patch is missing
                       # (e.g. after a dependency upgrade changed upstream sources)
```

To add a patch, append a `patchFile(...)` entry with exact `search` → `replace` strings; if `replace` contains `search`, set `skipIfPresent` so re-runs stay idempotent. The WhatsApp bridge (`whatsapp_bridge/`, baileys/qrcode only) needs none of these patches.

### 🚀 2. Running the Application

Start the assistant via the startup wrapper:

```bash
./starter.sh
# or if using Zsh:
zsh starter.sh
```

On Windows (`cmd.exe`) use the batch twin — same flags:
```cmd
starter.bat
starter.bat --web
```

#### Launch Flags:
* **Interactive CLI Chat**:
  ```bash
  ./starter.sh
  # or
  zsh starter.sh
  # or
  bun start
  ```
* **Real-Time Voice Web UI (Dagowan WebSocket Interface)**:
  ```bash
  ./starter.sh --web
  # or with Zsh:
  zsh starter.sh --web
  # or:
  bun run web
  ```
  Then open **`http://127.0.0.1:8767`** in your browser.
  The web bridge supports typed prompts, browser-recorded audio, local/OpenAI transcription, and speech replies. `bun test` includes a no-network integration check for all three paths.
* **OpenWebUI-Style Dashboard (`src/dashboard.js` + `dashboard.html`)**:
  ```bash
  ./starter.sh --dashboard   # single-dash -dashboard works too
  # or:
  bun run dashboard
  # custom port:
  ./starter.sh --dashboard-port 8899   # or DASHBOARD_PORT=8899
  ```
  Then open **`http://127.0.0.1:8768`** in your browser.
  Sidebar chat list, model + persona pickers, quick `@` tools, settings panel, and a REST API (`/api/health`, `/api/chat`, `/api/sessions`, `/api/characters`, `/api/memories`, `/api/tasks`, `/api/stats`, `/api/settings`, `/api/models`, `/api/commands`). Chat turns reuse the normal memory + knowledge + session-context LLM flow. Toggle from inside the app with `@dashboard [port]` / `@dashboard off` (`@dash` alias). Header buttons open the enabled popups: 👄 Avatar (`/avatar`), 🤖 AI Friend (`/aifriend`), 🤖💬 Bud Pro (`/aifrienddash`); the voice toggle fans AI replies out to the avatar / AI Friend popup for lipsync speech. Shares the `web` PIN/OTP lock scope with the voice UI (`@lock` / `@unlock`, mutating REST endpoints return `423` while locked). Env: `DASHBOARD_ENABLED=1` to autostart, `DASHBOARD_PORT` for the port (settings: `dashboard_enabled`, `dashboard_port` in `app_settings.json`). Unit-tested (`src/dashboard.test.js`, no network).
* **Avatar lipsync popup (`avatar.html`, 🎃 pumpkin theme)**:
  ```bash
  ./starter.sh --avatar   # implies --dashboard; --no-avatar always wins
  ```
  Then open **`http://127.0.0.1:8768/avatar`** (or the Avatar button in the dashboard header) and press 🔊 Enable audio. The popup is the only audio player — dashboard AI replies are fanned out to it (BroadcastChannel + storage fallback) and spoken with sample-accurate lipsync via server TTS (`POST /api/tts`, local MMS-TTS or OpenAI), with automatic browser-voice fallback when server synthesis is slow or unreachable. Slow local-TTS turns no longer drop the connection (server `idleTimeout` raised — previously surfaced as `net::ERR_EMPTY_RESPONSE`).
* **AI Friend avatar popup (`aifriend.html`, 🤖 AI Bud Pro character)**:
  ```bash
  ./starter.sh --aifriend   # implies --dashboard; --no-aifriend always wins
  # or: AIFRIEND_ENABLED=1 bun run dashboard
  ```
  Then open **`http://127.0.0.1:8768/aifriend`** (or the 🤖 AI Friend button in the dashboard header) and press 🔊 Enable audio. Vanilla-JS port of `ai_bud_pro/src/LiveCharacter3D.tsx` (Three.js cat-eye 3D character + speech bubble, idle/listening/thinking/speaking states, mouth driven by the AI Bud Pro animation curve + live server-TTS audio volume). Like `/avatar`, it is the only audio player — dashboard AI replies fan out to it over both `dagowan-avatar` and `dagowan-aifriend` channels (+ localStorage fallback), so `--avatar` and `--aifriend` popups are interchangeable. Status at `GET /api/aifriend-status`.
* **AI Friend dashboard (`aifrienddash.html`, 🤖💬 AI Bud Pro chat)**:
  ```bash
  ./starter.sh --aifrienddash   # implies --dashboard; --no-aifrienddash always wins
  # or: AIFRIENDDASH_ENABLED=1 bun run dashboard
  ```
  Then open **`http://127.0.0.1:8768/aifrienddash`** (or the 🤖💬 Bud Pro button in the dashboard header). Vanilla-JS port of `ai_bud_pro/src/main.tsx` wired to the dagowan dashboard REST API (`/api/chat`, `/api/sessions`, `/api/characters`, `/api/memories`, `/api/models`, `/api/settings`) instead of Ollama directly: sessions, rename/delete, search across conversations + memories, persona/model pickers, memory manager, theme/font prefs, export, browser speech recognition, optional read-aloud with mini 3D avatar, and a ↗ pop-out to `/aifriend`. Status at `GET /api/aifrienddash-status`. Combine flags to serve everything at once: `./starter.sh --dashboard --avatar --aifriend --aifrienddash`.
* **With WhatsApp Bridge** (opt-in; stays off unless a phone is linked or it is enabled):
  ```bash
  ./starter.sh --whatsapp
  # or with Zsh:
  zsh starter.sh --whatsapp
  ```
  Configure once with `@set-whatsapp-phone <number>` then `@whatsapp-enabled on`; link via the QR page or `@whatsapp-pair <number>` (numeric code — required on Termux, which cannot scan its own screen).
* **Run Unit & Tool Tests**:
  ```bash
  bun test
  ```
* **Run BabyAGI from the terminal**:
  ```bash
  bun run babyagi -- "Create a practical launch plan for an offline voice assistant" --iterations 4
  ```
* **One-shot ephemeral answer (model from settings, RAM freed afterwards)**:
  ```bash
  bun run ask "Why is the sky blue?"
  bun run ask --model smollm2:135m "Why is the sky blue?"
  ```

---

## 🐳 Docker Deployment (Run Anywhere)

Ship the whole toolsuite as a portable container with `Dockerfile` + `docker-compose.yml` and drive it via **`dockerize.sh`**. The image bundles the Bun runtime, Node.js (WhatsApp Baileys bridge), Python helpers, `ffmpeg`/`espeak`, and all JS dependencies with the ONNX patches pre-applied. Running Portainer? Use **`portainer-stack.yml`** and the step-by-step **`PORTAINER.md`** guide (named volumes only, no host bind mounts).

| Inside container | Host URL | Purpose |
|---|---|---|
| `8765` | `http://127.0.0.1:8765` | WhatsApp HTTP bridge (`/chat`, `/health`) |
| `8766` | `http://127.0.0.1:8766` | WhatsApp QR / pairing view (`/qr`) |
| `8767` | `http://127.0.0.1:8767` | Dagowan voice Web UI + WebSocket (`/ws`) |
| `8768` | `http://127.0.0.1:8768` | OpenWebUI-style dashboard (`/` + `/api/*`, opt-in via `DASHBOARD_ENABLED=1` / `--dashboard`) |

### Prerequisites
* Docker 24+ with the Compose v2 plugin (`docker compose version`).
* An Ollama daemon **either** on the host (`ollama serve`, default) **or** via the bundled compose profile. Cloud models work too (API keys only, no Ollama needed).

### 1. Configure (optional)
```bash
cp .env.example .env
# then edit .env: OLLAMA_HOST, OPENAI_API_KEY / GEMINI_API_KEY / ...
```

### 2. Build & run — single container
```bash
chmod +x dockerize.sh
./dockerize.sh build
./dockerize.sh run            # interactive CLI (+ --web; adds --whatsapp when WHATSAPP_ENABLED=1 / WHATSAPP_PHONE is set), Ctrl+C to stop
./dockerize.sh run --detach   # background mode
./dockerize.sh logs -f        # follow logs
docker attach dagowan         # re-attach to the interactive CLI
```

### 3. Or via Compose (recommended for persistence)
```bash
./dockerize.sh up              # app only, uses host Ollama at host.docker.internal:11434
./dockerize.sh up --ollama     # also starts bundled `ollama/ollama` daemon
# first time with bundled Ollama, pull a model once:
docker exec -it dagowan-ollama ollama pull llama3
./dockerize.sh down
```

### 4. Pointing at Ollama
* **Host Ollama (default):** keep `OLLAMA_HOST=http://host.docker.internal:11434` and run `ollama serve` on the host. On native Linux add `--add-host=host.docker.internal:host-gateway` (already set in `dockerize.sh` / compose `extra_hosts`).
* **Bundled Ollama:** `./dockerize.sh up --ollama` with `OLLAMA_HOST=http://ollama:11434`.
* **ollama-lite (bun-ollama) backend:** any Ollama-compatible server on `settings.server_url` (default `http://127.0.0.1:11434`) works, including `ollama-lite serve` / `ollama-lite daemon` (they share one port + PID file, so run only one). Use the canonical model name `llama3.2:1b` (`ollama:llama3.2:1b` is accepted as an alias; `llama:3.2:1b` with the extra colon is invalid). Note: local CPU inference on small hosts can take 60–130s+ per turn — if replies come back empty, make sure ollama-lite is updated past the `idleTimeout: 255` server fix and restarted.
* **Cloud-only (no Ollama):** set any provider key and switch models in-app (`@set-api-key gemini ...`, `@model gemini-2.5-flash`).

### Persistence & backups
Bind mounts keep host copies of `./notes`, `./pdfs`, `./projects`, `./backups`, `./logs`, `./tmp`; named volumes keep `data/bot.db` (`dagowan-data`), WhatsApp auth (`dagowan-wa-auth`), and root `*.json` state (`dagowan-config`, synced by the entrypoint so `app_settings.json`, `characters.json`, `memory.json`, `chat_sessions.json`, `tasks.json` survive rebuilds). When a host `*.json` file exists next to `dockerize.sh`, `run` bind-mounts it directly for live editing. Use `@export-settings` (lands in `./backups`) for portable backups.

WhatsApp is opt-in: the container starts `--web` by default and adds `--whatsapp` only when `WHATSAPP_ENABLED=1` or `WHATSAPP_PHONE` is set. Pairing UX is controlled by `WHATSAPP_QR_MODE=auto|qr|pairing|off` (`auto` = numeric code on Termux, QR elsewhere; Termux cannot scan a QR with its own camera, so use `@whatsapp-pair <phone>` / `POST /pair`).

### More helpers
```bash
./dockerize.sh shell   # shell inside the running container
./dockerize.sh stop / ./dockerize.sh start / ./dockerize.sh rm
./dockerize.sh clean   # remove container + image + data volumes (host bind dirs untouched)
```

### 5. Or via Portainer
Deploy with **`portainer-stack.yml`** (named volumes only — no host bind
mounts, so it works from the Portainer UI) following **`PORTAINER.md`**:
repository stack for auto-build, or build + push once and paste the stack
with `build:` removed. WhatsApp stays opt-in there too
(`WHATSAPP_ENABLED` / `WHATSAPP_PHONE`, `WHATSAPP_QR_MODE`).

> Note: servers bind `0.0.0.0` inside the container (via `BIND_HOST`) so published ports are reachable; on bare metal they still answer on `127.0.0.1` as before. Ports/URLs can be overridden with `WHATSAPP_PORT`, `WHATSAPP_STATUS_PORT`, `VOICE_PORT`/`WEB_PORT`, `OLLAMA_HOST`/`OLLAMA_URL`.

---

### 🔑 3. Configure API Keys (Optional for Cloud LLMs)

You can set provider API keys via environment variables, a `.env` file, or using @ commands inside the application.

#### Option A: `.env` file
Create a `.env` file in the root directory:
```env
OPENAI_API_KEY=sk-proj-...
GEMINI_API_KEY=AIzaSy...
CLAUDE_API_KEY=sk-ant-...
GROK_API_KEY=xai-...
MISTRAL_API_KEY=...
SEMANTIC_SCHOLAR_API_KEY=... # optional, free; raises @fact-check rate limits
FACTCHECK_SOURCE=auto # @fact-check engine: auto|papers|gemini (Gemini verdict needs GEMINI_API_KEY)
BRAVE_API_KEY=... # optional; upgrades live web search engine (auto-selected when set)
TAVILY_API_KEY=... # optional; upgrades live web search engine (auto-selected when set)
GEMINI_SEARCH_MODEL=gemini-2.5-flash # @live-gemini Google AI Mode grounding model (needs GEMINI_API_KEY)
WEBSEARCH_PROVIDER=auto # live web search engine: auto|duckduckgo|brave|tavily|google-ai (DuckDuckGo needs no key)
WEBSEARCH_MAX_RESULTS=5 # live web search results per search (1-10)
FACTCHECK_GEMINI_MODEL=gemini-2.5-flash
```

#### Option B: In-App @ Commands
Inside the running application:
```text
@set-api-key openai sk-proj-...
@set-api-key gemini AIzaSy...
@set-api-key claude sk-ant-...
@set-api-key grok xai-...
@set-api-key mistral ...
@set-api-key semanticscholar ...
@set-api-key brave ... # optional; upgrades live web search engine
@set-api-key tavily ... # optional; upgrades live web search engine
```

---

## 🛠 Complete @ Commands Reference

### 🎙 Local Voice & Audio Commands (Offline)
* `@web` (or `@voice-socket`, `@voice-server`, `@dagowan`) — Launch/toggle real-time duplex voice web interface (`http://127.0.0.1:8767`). Voice-only; live web search uses `@live-web` / `@web-search` (see 🌐 Live Web Search below).
* `@dashboard [port]` / `@dashboard off` (or `@dash`) — Launch/toggle OpenWebUI-style chat dashboard (`http://127.0.0.1:8768`; custom port via `@dashboard 8899`, `DASHBOARD_PORT`, or `--dashboard-port N`).
* `@voice <audio_file_path>` — Transcribe audio file locally (Whisper STT), process question with LLM, and synthesize response.
* `@tts <text>` — Synthesize text locally into a speech `.wav` file using local MMS-TTS model.
* `@voice-reply [on|off]` (or `@voicereply`) — Toggle automatic local voice note response generation for answers.

### 🌐 Live Web Search
* Mention `@live-web` anywhere in a sentence (`latest BTC price @live-web`) — the turn runs a real-time search and injects the results into the model's context, on CLI, Telegram, WhatsApp, Web UI, and the Chrome side panel.
* Mention `@live-gemini` anywhere (`explain black holes @live-gemini`) — Google AI Mode search (Gemini `google_search` grounding with `GEMINI_API_KEY`, else keyless Google scrape, else DuckDuckGo fallback), same context injection as `@live-web`.
* `@live-web <query>` / `@live-gemini <query>` / `@web-search <query> [--provider auto|duckduckgo|brave|tavily|google-ai] [--limit N]` (or `@websearch`, `@search-web`) — Explicit search; results print as chat and persist to the session. (`@web` stays voice-only.)
* `@web-fetch <url>` (or `@webfetch`) — Fetch a page as plain text.
* `@web-status` — Show engine configuration (provider chain, key status).
* Engines: Brave → Tavily (with `@set-api-key brave|tavily <key>`) → keyless DuckDuckGo; Google AI Mode via `@live-gemini` / `--provider google-ai` (needs `@set-api-key gemini <key>` for grounded answers, else keyless scrape + DDG fallback). MCP pair: `web__web_search` / `web__web_fetch`. Settings: `websearch_enabled`, `websearch_provider`, `websearch_max_results`, `websearch_timeout_ms`, `gemini_search_model`.

### 🤖 LLM Models & Multi-Provider API Keys
* `@models` — List all available models across local Ollama, OpenAI, Gemini, Claude, Grok, and Mistral.
* `@model [model-name]` — View or switch the single shared model (e.g., `@model gemini-2.5-flash`, `@model claude-3-5-sonnet-20241022`, `@model grok-2-latest`, `@model mistral-large-latest`, `@model gpt-4o`, `@model llama3`). The change is applied to CLI chat, web voice, Telegram, WhatsApp, learning, BabyAGI, personas, and coding tools.
* `@ephemeral [on|off|status]` (or `@one-shot`) — Toggle one-shot Ollama inference via the bun-ollama CLI (default ON: every Ollama turn loads the model, answers once, then unloads it so RAM is freed; OFF uses the persistent `server_url` daemon with the model resident). Same command on CLI, Telegram, WhatsApp, web voice, and dashboard. Settings: `ollama_ephemeral`, `ollama_lite_dir` (auto-detected: setting → `OLLAMA_LITE_DIR` → `ollama-lite` on `PATH` → sibling checkout), `ollama_ephemeral_timeout_ms` (default 180000), `ollama_ephemeral_strip`. Note: the `@make` coding agent loop always needs the persistent endpoint for its multi-step tool calls.
* `@set-api-key <provider> <api_key>` (or `@set-key <provider> <key>`) — Set API key for `openai`, `gemini`, `claude`, `grok`, `mistral`, `youtube`, `spotify`, `wordpress` (`<site_url> <username> <app_password>`), `blogger` (`<blog_id> <access_token>`), `semanticscholar` (optional free key, raises `@fact-check` rate limits), `brave` / `tavily` (optional, upgrade live web search — DuckDuckGo works keyless).
* `@api-keys` (or `@keys`) — View status and source of configured provider API keys, plus the `@play`/`@spotify`, `@blog`, `@fact-check`, and live web search engine status.

### 🛠 Ollama CLI Agentic Coding & Project Commands
* `@change-project-path <path>` (or `@project-path`) — Set and persist project/code output directory for `@make` and `@create-file` (saved in `app_settings.json` and `~/.ollama_cli.json`).
* `@make <project_description>` — Execute Ollama CLI agentic toolset (read/write files, list dir, run shell commands, grep search, local browser) to build complete projects in the configured project path.
* `@create-file <file_path> [content|prompt]` — Create or generate a file using Ollama CLI toolset in the project path (auto-creates missing parent directories).
* `@opencli <task_description>` — API-driven OpenAI coding agent: real tool loop (read/write/list/search/run, default `gpt-4o-mini`) jailed to the project path. Safety rails: path jail (absolute/`..` escapes refused), `run_command` forced to project cwd with secrets scrubbed from env + destructive patterns refused, iteration cap (`opencli_max_iterations`, default 12), audit log (`logs/opencli.log`). Telegram/WhatsApp are owner-gated (`@set-setting opencli_allowed_chats ["<chat_id_or_jid>"]`); CLI/Web UI are local. Disable everywhere with `@set-setting opencli_enabled 0`.
* `@opencode <task_description>` — Run the external `opencode` CLI (`opencode run --format json <task>`, scoped to the project dir via spawn cwd **plus `PWD=<projectDir>`** — the CLI resolves its session directory from `PWD`, not the process cwd, so without the override files land in the bot's own directory; no path positional, see `opencode run --help`). Requires `@set-project-path <dir>` first (no silent default); model is never defaulted — set it with `@opencode-model <provider/model>` or configure it in opencode itself (`<projectDir>/opencode.json` / `~/.config/opencode/opencode.json`). Opt-in `--auto` approvals via `@set-setting opencode_auto 1`, timeout via `opencode_timeout_ms` (default 180000 ms), binary override via `opencode_bin`/`OPENCODE_BIN`, audit log (`logs/opencode.log`). Telegram/WhatsApp are owner-gated (`@set-setting opencode_allowed_chats ["<chat_id_or_jid>"]`); CLI/Web UI are local. Disable everywhere with `@set-setting opencode_enabled 0`.
* `@opencode-model [<model>]` — Show (no args) or set the `@opencode` model: user setting first, else the model from the project/global `opencode.json`, else opencode's own default.
* `@opencode-setup [status|path <dir>|model <m>|model clear|models|auth|bin <path>|auto on|off|auto-allow [full|safe|review|status|clear]|test [task]]` — Guided opencode setup on any surface: checks binary/auth/project-path/model with fix commands (`@opencode-setup path ./projects/my-app`, `@opencode-setup model ollama/qwen3:8b`, …) and finishes with an end-to-end `@opencode-setup test` probe.
* `@opencode-setup-auto-allow [full|safe|review|status|clear]` (alias for `@opencode-setup auto-allow …`) — Write auto-allow file permissions into `<projectDir>/opencode.json` so opencode can create/add files and review code without prompting (full = file ops + bash allow; safe = file ops allow, bash asks; review = read-only).

### 🍼 BabyAGI Autonomous Planning
* `@babyagi <objective> [--iterations N]` — Run the integrated classic BabyAGI loop. It executes the next task, creates relevant follow-up tasks, reprioritizes the queue, and uses prior results as context. `N` is 1–20 (default 3).
* `@babyagi-status` — Display registered BabyAGI agents plus persisted execution-log and vector-memory counts.
* `bun run babyagi -- "<objective>" --iterations N` — Run the same loop non-interactively.

### 🔌 MCP (Model Context Protocol) Servers
* `@mcp-status` — Show MCP enabled state, configured servers, and connection state (auto-creates `mcp_servers.json` with the built-in offline `local` + live-search `web` servers on first run).
* `@mcp-list` — List configured MCP servers from `mcp_servers.json`.
* `@mcp-tools [server]` — List tools from connected MCP servers (agents address them as `<server>__<tool>`, e.g. `local__read_file`).
* `@mcp-call <server__tool> [json_args]` — Call one MCP tool directly, e.g. `@mcp-call local__ping`, `@mcp-call local__read_file {"file_path":"package.json"}`.
* `@mcp-reconnect [server]` — Drop cached connections (lazy re-spawn on next use).
* `@mcp-enable <server>` / `@mcp-disable <server>` — Toggle a server in `mcp_servers.json`.
* Add any MCP stdio server to `mcp_servers.json` (see `mcp_servers.example.json`); the `@make` coding agent picks its tools up automatically. Settings: `mcp_enabled`, `mcp_config_path`, `mcp_timeout_ms`.

### 📄 PDF & Markdown Note Tools
* `@convert-pdf [from_date] [to_date]` (or `@pdf 2026-07 2026-08`) — Batch convert Markdown notes to PDF files in `pdfs/`.
* `@pdf-to-md <filename.pdf>` (or `@convert-md notes.pdf`) — Extract PDF text into Markdown note files in `notes/`.
* `@fetch-note-about <topic>` (or `@write-about <topic>`) — Search notes for topic and synthesize response.

### 📋 Kanban Task Management
* `@register-task <description>` (or `@task <desc>`) — Register a new task into Processing status (`p`).
* `@get-tasks` (or `@tasks`) — List active (unfinished) tasks.
* `@all-tasks` — List all tasks including finished.
* `@move-task-<id>-(p|o|f)` (or `@move-task <id> <p|o|f>`) — Move task status (**p**: processing, **o**: ongoing, **f**: finished).
* `@delete-task-<id>` (or `@delete-task <id>`) — Delete task by ID.
* `@set-task-reminder <minutes>` — Enable automatic background task reminders.
* `@stop-task-reminder` — Disable task reminders.
* `@task-reminder-status` — Show current task reminder configuration.

### ⏱ Proactive Chat & Timer Commands
* `@set-proactive-timer <minutes>` (or `@proactive-timer <mins>`) — Set proactive chat idle timer in minutes (and enable proactive chat).
* `@proactive-chat [on|off]` (or `@proactive [on|off]`) — Enable, disable, or toggle proactive chat check-ins.
* `@proactive-status` (or `@proactive-timer-status`) — View current proactive chat timer & check-in settings.
* `@stop-proactive-timer` (or `@stop-proactive`) — Disable proactive chat check-ins.
* `@set-proactive-check <seconds>` (or `@proactive-check <secs>`) — Set background check frequency in seconds (default 60s).

### 🧠 Incremental Memory & Knowledge Commands (Eliza Cognitive Layer)
* `@remember <text>` — Save a persistent memory for the ACTIVE character only (each bot has a private pool + shared legacy entries; turn language auto-detected).
* `@memories [query]` (or `@memory`, `@list-memories`) — List recent active persistent memories (15) for the ACTIVE character (shows `[owner]` `[lang]` per entry) or search with types and confidence scores (query language auto-detected: same-language pool + shared first, other languages via bridge).
* `@memories-all [query]` (or `@memory-all`, `@list-memories-all`) — List ALL active persistent memories for the ACTIVE character, or search across all.
* `@memory-langs` — Show per-language memory pool counts.
* `@forget <id|index>` (or `@delete-memory`) — Deactivate/forget a specific memory by ID or index (only within the active character's visible pool).
* `@update-memory <id|index> <new text>` — Update memory content (only within the active character's visible pool).
* `@correct <statement>` — Submit an explicit user correction for the ACTIVE character (superseding conflicting prior beliefs in its pool).
* `@knowledge [query]` (or `@list-knowledge`) — List or search knowledge base concepts & entries.
* `@teach <title: content>` — Explicitly teach the bot a structured concept or definition.
* `@knowledge-history <id>` — View version history of a knowledge concept.
* `@delete-knowledge <id>` — Deprecate/remove a knowledge entry.
* `@stats` (or `@learning-stats`) — Display database, memory, knowledge, and learning statistics (includes a per-character memory breakdown).
* `@learning-logs [limit]` — View recent incremental learning events log.
* `@set-learning [on|off]` (or `@auto-learning`) — Toggle automatic background LLM learning extraction.
* `@rules [status]` — Inspect candidate and approved pattern rules.
* `@approve-rule <id>` — Approve a candidate rule.
* `@insight [optional focus]` — Write today's daily self-reflection with the active LLM into `data/reflections.json` (one per character per day; lock-gated; works on CLI, Telegram, WhatsApp, Web, Dashboard).
* `@insights [N]` (or `@insight-list`) — List recent self-reflections for the ACTIVE character.
* `@insight-search <query>` — Search the reflection bank by association.
* `@insight-show <id|YYYY-MM-DD>` — Show one reflection entry.
* `@insight-delete <id|YYYY-MM-DD>` — Delete one reflection entry.
* `@insight-status` — Show reflection count and latest entry for the active character.

### 🎭 Character Profiles & Personas
* `@character [name|id]` — View or switch active character persona profile (wakes its Telegram polling on demand).
* `@characters` — List available character profiles.
* `@polling-status` (or `@polling`, `@pollers`) — Show per-persona Telegram polling state (active always polls; idle personas auto-sleep after `persona_idle_timeout_minutes`).
* `@wake <name|id>` — Start Telegram polling for a persona on demand.
* `@sleep <name|id>` — Stop polling for an idle persona (active persona cannot sleep).
* `@set-polling-idle <minutes>` — Set idle auto-sleep timeout for non-active personas (`0` disables auto-sleep; saved to `app_settings.json` as `persona_idle_timeout_minutes`).
* `@create-character <Name> | <Prompt>` — Create a custom character persona using the shared model.
* `@set-persona-prompt <prompt>` — Set system prompt template for active character.
* `@set-telegram-token <token>` — Save Telegram bot token to character profile.
* `@whatsapp-pair <phone_number>` — Generate WhatsApp 8-digit phone pairing code.
* `@set-whatsapp-phone <phone_number>` (or `@whatsapp-number`) — Set default WhatsApp phone number.
* `@reset-whatsapp-auth` — Clear stale WhatsApp auth keys to reconnect.

### 🎭 Simulation Mode
* `@simulation <name> [optional note]` — Start/resume a simulation; normal chat with the active persona, saved to its own archive in `data/simulations/`.
* `@simulation-end` (or `@simulation-stop`, `@simulation-passed`, `@simulation-pass`, `@simulation end|stop|passed`) — Archive & end the active simulation.
* `@simulation` (bare) — Show active simulation status.
* `@simulations` (or `@simulation-list`) — List simulation archives.
* `@simulation-search <query>` — Search across simulation archives by association.
* `@simulation-show <name>` — Show a simulation archive summary.
* `@simulation-review <name>` (or `@simulation review <name>`) — Full review of ALL conversational data in a saved simulation (stats + topics + every turn).
* While a simulation is active, chats and `@remember`/`@correct`/`@memories` stay inside the simulation file; past archives are recalled automatically when the prompt matches.

### 💬 Chat Session Management
* `@sessions` — List saved conversation sessions for the ACTIVE character.
* `@session <id>` — Switch to session by ID (only within the active character's sessions).
* `@new-session` — Start a fresh chat session for the ACTIVE character.
* `@delete-session <id>` — Delete session by ID (only within the active character's sessions).
* `@rename-session <title>` — Rename active session.
* Past-conversation context injected into prompts is filtered by character, so bots never see each other's chat history.

### 💾 Backup & Settings
* `@export-settings [filename]` (or `@backup`) — Export application state, memories, knowledge, tasks, and sessions to `backups/`.
* `@import-settings [filename]` (or `@restore`) — Restore application state from a backup file.
* `@list-backups` — List available backup files.

### 🔒 Security PIN + 🔐 OTP 2FA (control-command lock)
* `@set-security-pin <6+ digits> [current-pin]` (or `@set-pin`) — Set or change the PIN (digits only, min 6). First-time setup needs no PIN; changing it needs `@unlock` or the current PIN passed inline. Setting a PIN unlocks the current surface.
* `@unlock <pin>` — Unlock control commands on this surface for the configured duration (`security_unlock_minutes`, default 10, `@set-setting security_unlock_minutes <1-1440>` while unlocked; the `@help` manual, `@security-status`, `@otp-status`, and all lock replies always print the live value). When OTP is enrolled, `@otp-login` is required **before** `@unlock`.
* `@lock` — Lock immediately (PIN layer; OTP auth is dropped separately with `@otp-lock`). `@security-status` (or `@security`, `@pin-status`) — Show whether a PIN/OTP is set and whether this surface is unlocked.
* `@remove-security-pin [pin]` (or `@clear-security-pin`) — Remove PIN protection (needs unlock or the current PIN).
* `@otp-set [account]` — Enroll a new authenticator secret (Google Authenticator / Authy / 1Password — standard TOTP, no extra install). Needs `@unlock` first when a PIN is set; rotating an existing secret needs `@otp-login` + `@unlock`. Prints the secret + `otpauth://` URL to add in your app, then verify with `@otp-login`.
* `@otp-login <6-digit code>` — Authenticate this surface with the current authenticator code (CLI / Telegram / WhatsApp / Web log in separately; per-chat on Telegram/WhatsApp; same TTL as the PIN).
* `@otp-lock` — Drop OTP authentication on this surface. `@otp-status` (or `@otp`) — Show whether OTP is enrolled and whether this surface is authenticated.
* `@otp-remove <code>` — Remove OTP protection; requires **both** OTP authentication (code may be passed inline) **and** `@unlock` when a PIN is set.
* While a PIN or OTP is set, **every** `@` control command on CLI, Telegram, WhatsApp, and Web UI stays locked until the required logins succeed — including `@help` / `@commands` / `@get-commands` (the command manual is only shown after `@otp-login`, plus `@unlock` when a PIN is set; natural blog publish intents are locked too). Regular chatting — including `@Name` persona mentions — always works without the PIN/OTP. The PIN is stored only as a salted SHA-256 hash (`security_pin_hash`/`security_pin_salt` in `app_settings.json`); the OTP secret (`otp_secret`, manageable only via `@otp-*`, never via `@set-setting` or the Web settings event) is never displayed. Auth state is in-memory and expires, so a restart always re-locks. Lost PIN recovery: stop the bot and delete those two keys from `app_settings.json` locally; lost OTP recovery: stop the bot and delete `otp_secret` from `app_settings.json` locally (then re-enroll with `@otp-set`).

### 🔍 Search & Web Browser
* `@fact-check <claim> [--limit N] [--source auto|papers|gemini] [--model <gemini-model>] [--no-verdict]` (or `@factcheck`, `@verify`) — Search Semantic Scholar (`src/factcheck_api.js`) for papers (title, abstract, year, citation count, DOI, open-access PDF) to verify a claim. Anonymous access works; set `SEMANTIC_SCHOLAR_API_KEY` (or `@set-api-key semanticscholar <key>`) to raise rate limits. With `GEMINI_API_KEY` (or `@set-api-key gemini <key>`) a Gemini verdict is added on top (`--source gemini` for verdict only, `--no-verdict` for papers only). Tune with `@set-setting factcheck_max_results <1-10>` / `@set-setting factcheck_source <auto|papers|gemini>`. Also available to the coding agent as `fact_check_papers`.
* `@needle <request>` — On-device routing via cactus-needle (`src/needle.js` + `src/needle_bridge.py`): picks a local tool (remember / task / note / timer) with grammar-guaranteed args + confidence; executes only at/above `needle_min_confidence` (default 0.7, `@set-setting needle_min_confidence <0-1>`), otherwise shows the proposal for confirmation. Needs `pip install cactus-needle` (weights download once, then offline); custom model via `@set-setting needle_model_path <file.cact>`.
* `@needle-extract <JSON schema> <text>` — Typed field extraction without a large LLM (refuses rather than inventing fields).
* `@needle-embed <text>` / `@needle-tools` / `@needle-status` — Local embedding debug, on-device catalog, install/model/threshold status.
* `@youtube-play <query|YouTube URL> [--no-show]` (or `@play`) — API-first playback (YouTube Data API, `YOUTUBE_API_KEY`): resolves the top video via API and hands it to your system default browser. Chromium automation is the fallback when no key is set or the API fails. Force engine with `PLAY_SOURCE=auto|api|browser` (`@set-setting play_source <mode>`).
* `@spotify-play <query|Spotify URL> [--no-show]` (or `@spotify`) — API-first playback (Spotify Web API, `SPOTIFY_CLIENT_ID`/`SPOTIFY_CLIENT_SECRET`): resolves the top track/episode via API and hands it to your default browser / Spotify app. Chromium automation is the fallback.
* `@blog <topic> [--on wordpress|blogger] [--title <title>] [--no-show]` (or `@wordpress`, `@blogger`, `@post`) — API-first blog draft (WordPress REST API, `WORDPRESS_SITE_URL`/`WORDPRESS_USERNAME`/`WORDPRESS_APP_PASSWORD`; Blogger API v3, `BLOGGER_BLOG_ID`/`BLOGGER_ACCESS_TOKEN`): the active LLM writes a complete post (350-550 words HTML; starter template only if the model is unreachable), creates a real draft post and hands the editor to your system default browser. Chromium editor automation is the fallback when no tokens are set or the API fails. Force engine with `BLOG_SOURCE=auto|api|browser` (`@set-setting blog_source <mode>`). Natural callout also works in chat/bridges: `@Parsly, write a blog post about <topic> on @wordpress` (or `on @blogger`).
* `@browser-search <query>` — YouTube search in the local browser window, top results without playing.
* `@browser-search-spotify <query>` — Spotify search in the local browser window, top results without playing.
* `@browser-open <url>` — Navigate the local browser window (allowlisted domains only).
* `@browser-read` — Read text of the current page.
* `@browser-shot [name]` — Screenshot the current page into `tmp/`.
* `@browser-status` / `@browser-close` — Inspect / shut down the browser.
* `@search-youtube-for <query>` — Search YouTube in default host browser (legacy fire-and-forget open).
* `@search-google-for <query>` — Search Google in default browser.
* `@search-giphy-for <query>` — Search Giphy in default browser.
* `@open-browser` — Open system web browser.

#### 🌐 Playback: official APIs first, Chromium fallback
`@youtube-play`/`@play` and `@spotify-play`/`@spotify` resolve via the official APIs by default (`src/play_api.js`) and hand the URL to your system default browser — no Chromium needed. The previous Playwright/Chromium automation (`src/browser.js`) is now the fallback when API keys are missing or the API request fails (force with `PLAY_SOURCE=auto|api|browser` or `play_source` in `app_settings.json`).
* **YouTube**: needs a YouTube Data API v3 key (`YOUTUBE_API_KEY` env or `@set-api-key youtube <key>`; enable "YouTube Data API v3" in Google Cloud Console). Search calls `youtube/v3/search` (`part=snippet`, `type=video`, top result). Direct watch/shorts/youtu.be URLs skip the API (title via oEmbed) and just hand off.
* **Spotify**: needs app credentials (`SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` env or `@set-api-key spotify <id> <secret>`; from developer.spotify.com dashboard). Uses client-credentials token + `api.spotify.com/v1/search` (`track,episode,album,playlist,show,artist`), preferring track/episode matches. Direct `open.spotify.com/...` / `spotify:...` URLs skip the API and just hand off.
* **Fallback**: the assistant drives a real, **visible local browser window** and hands videos off to your system default browser (`src/browser.js`, lazy-loaded Playwright):
* **One shared browser** across CLI `@` commands, Telegram / WhatsApp bridges, and the Ollama CLI agent loop (`browser_open`, `browser_search_youtube`, `browser_play_youtube`, `browser_search_spotify`, `browser_play_spotify`, `browser_draft_blog`, `browser_read`, `browser_screenshot` in `ollama_cli/src/tools.ts`), so local models can chain search → click → read like the coding tools chain file ops. All surfaces share one `@play`/`@youtube-play` parser (`parsePlayInput`), one `@spotify`/`@spotify-play` parser (`parseSpotifyPlayInput`), one `@blog`/`@wordpress`/`@blogger`/`@post` parser (`parseBlogInput`), and reply format.
* **YouTube flow**: `@youtube-play lofi hip hop` opens `results?search_query=…` in the visible window, clicks the first `ytd-video-renderer` card, waits for the watch page and asserts the `<video>` element is actually playing — then hands the watch URL to your system default browser (so it plays where you look) and pauses the controlled copy to avoid double audio. Pass `--no-show` to skip the handoff.
* **Spotify flow**: `@spotify-play <song|podcast>` opens `open.spotify.com/search/…`, prefers a track/episode match over same-name albums/playlists (with a reload retry when the logged-out render only yields a playlist), clicks the matching result card, clicks the first visible play button (retried once) and verifies playback via the header button flipping to "Pause" / a live media element — then hands the Spotify URL to your default browser / app where you're logged in for full playback and pauses the controlled copy. The handoff is verified (exit-checked, `$BROWSER` honored first, then `xdg-open`/`open`/fallbacks), so if the host browser can't be reached you'll get a `Default-browser handoff failed: …` line instead of silence — the URL stays visible in the controlled Chromium window in that case. After a verified handoff the controlled window auto-closes (`--no-show` keeps it open); the reply notes `Controlled window closed.` Unlike YouTube, the opened Spotify page never autoplays on load, so the reply reports `State: playing` vs `loaded (not playing yet…)` plus a login hint when Spotify shows its signup wall. Full-track playback in the controlled window requires a Spotify login in `data/browser-profile/`; direct URLs (`open.spotify.com/...` or `spotify:...` URIs) skip the search.
* **Blog flow**: `@blog <topic> [--on wordpress|blogger]` (aliases `@wordpress`, `@blogger`, `@post`) writes a complete post with the active LLM (starter template only if the model is unreachable), then creates the draft via the official APIs by default (`src/blog_api.js`) and hands the editor URL to your system default browser — no Chromium needed.
  * **WordPress**: needs site + user + Application Password (`WORDPRESS_SITE_URL` / `WORDPRESS_USERNAME` / `WORDPRESS_APP_PASSWORD` env or `@set-api-key wordpress <site_url> <username> <app_password>`; generate the password in WP Admin → Users → Profile → Application Passwords). Self-hosted sites create a real `draft` via `POST {site}/wp-json/wp/v2/posts` ([authentication](https://developer.wordpress.org/rest-api/using-the-rest-api/authentication/)). WordPress.com hosted sites don't expose `/wp-json` at the site domain (404), so the code falls back to XML-RPC `wp.newPost` at `{site}/xmlrpc.php` with the same credentials. Either way hands off the `wp-admin/post.php?post=<id>&action=edit` URL.
  * **Blogger**: needs blog id + OAuth2 access token (`BLOGGER_BLOG_ID` / `BLOGGER_ACCESS_TOKEN` env or `@set-api-key blogger <blog_id> <access_token>`; Blogger writes require OAuth — a plain API key is read-only and cannot create drafts). Easiest path: drop your `client_secret_*.apps.googleusercontent.com.json` in the project folder and run `@blogger-auth` (CLI) — see "Blogger OAuth" below. Creates a draft via `POST blogger/v3/blogs/{blogId}/posts?isDraft=true`.
  * **Fallback**: with no tokens (or on API failure) the assistant opens the WP `wp-admin/post-new.php` (or `wordpress.com/post`) / Blogger posts page in the visible local window, pre-fills title + starter body best-effort, and hands the editor URL to your default browser where you log in and save/publish — same verified-handoff + auto-close pattern as `@play`. Blogger uses the `draft.blogger.com` host, opening the blog's posts page (`/blog/posts/<blogId>`, "New post" is one click away) when `blogger_blog_id` is set (`@set-api-key blogger <blog_id> <access_token>` saves it even without a token). Force engine with `BLOG_SOURCE=auto|api|browser` (`@set-setting blog_source <mode>`). Only drafts are ever created — nothing auto-publishes. If your `app_settings.json` predates this feature and the browser reports `URL not allowed by browser allowlist`, add `wordpress.com,blogger.com,blogspot.com` to `browser_allowed_domains` (or `BROWSER_ALLOWED_DOMAINS`).
  * **Callouts**: `@Parsly, write a blog post about <topic> on @wordpress` (or `on @blogger`) is detected in CLI/Telegram/WhatsApp/Web UI (`detectBlogIntent`) and drafts directly, bypassing the group mention gate like `@play`; the Ollama agent loop gets the same capability via the `browser_draft_blog` tool (which also accepts full `title`/`content`).

#### 🔑 Blogger OAuth (`@blogger-auth`, CLI only)
The Blogger API needs a user OAuth token — no client-credentials flow exists. Setup (one time):
1. Google Cloud → APIs & Services → Credentials → create an **OAuth client ID** (any type; enable the **Blogger API v3** for the project) and download its `client_secret_*.apps.googleusercontent.com.json` into the project folder (gitignored, never committed).
2. In the same credential, add this exact **Authorized redirect URI**: `http://127.0.0.1:8791/callback` (fixed loopback port; override with `BLOGGER_AUTH_PORT` only if you also update the registration). Copy it character-for-character: Google compares URIs exactly, so `localhost` vs `127.0.0.1`, a trailing slash, or a wrong port all fail with `Error 400: redirect_uri_mismatch`. After saving, wait a minute or two for the change to propagate. (If you already registered the `localhost` variant instead, set `BLOGGER_AUTH_HOST=localhost` / `@set-setting blogger_auth_host localhost` and retry — the flow will use it.)
3. Run `@blogger-auth [optional path to the json]` — approve in your browser. Access + refresh tokens are stored in `app_settings.json` (`blogger_access_token`, `blogger_refresh_token`, `blogger_token_expiry`) and refreshed automatically (including a one-retry refresh on HTTP 401 mid-draft).
* **Display-less fallback**: on servers / Docker (no `DISPLAY`/`WAYLAND_DISPLAY`, macOS/Windows always count as having one) it automatically runs headless; a failed visible launch also retries headless. Force either mode with `BROWSER_HEADLESS=0/1` or `browser_headless: false/true/"auto"` in `app_settings.json`.
* **Safety rails**: domain allowlist (`app_settings.json: browser_allowed_domains` or `BROWSER_ALLOWED_DOMAINS`), 30s navigation timeouts (`BROWSER_NAV_TIMEOUT_MS`), idle auto-close after 5 min of no browser action (`browser_idle_close_ms` / `BROWSER_IDLE_CLOSE_MS`, `0` disables), persistent profile in `data/browser-profile/`, and every action appended to `logs/browser.log`.
* **Setup**: `playwright` is already in `package.json`; `install.sh` / `install_ubuntu.sh` fetch the Chromium engine (~170MB) automatically, and the Docker image bakes it in at build time. On a manual setup, download it once with `bunx playwright install chromium`. Without the engine, every browser command fails with the exact install hint instead of crashing.

### 📺 TV Cast (DLNA + Chromecast)
* `@cast-scan` (or `@scan-tv`) — List TVs/renderers on your LAN (DLNA + Chromecast).
* `@cast <url>` — Auto: direct video URL casts as-is, page URL is extracted first.
* `@cast <youtube-url>` — Plays in the TV's native YouTube app (needs a Chromecast/Android TV target; honours `t=` start time).
* `@cast-url <url>` — Cast a direct stream/video URL (`.mp4`, `.mkv`, `.m3u8`, …).
* `@cast-player <page-url>` — Extract the video from a web page, then cast.
* `@cast-pause` / `@cast-play` — Pause / resume playback on the TV.
* `@cast-status` — Show current cast session + TV state.
* `@cast-stop` (or `@stop-cast`) — Stop playback and shut down the relay.
* `@set-cast-device <name|ip|description-url>` — Select/pin the target TV (IP pin uses unicast, works where multicast is blocked).
* `@set-setting cast_device_type <auto|dlna|chromecast>` — Force a cast protocol; `@set-setting cast_max_height 1080` caps transcode height.
* Same commands on CLI, Telegram, WhatsApp, and Web UI (group-safe). Machine and TV must share a LAN; YouTube URLs need a Chromecast target (DLNA can't play them); no DRM. In Docker, discovery needs `network_mode: host` on Linux (commented option in `docker-compose.yml`); bridge mode only works with a pinned IP over the published relay port.

### ℹ️ General Controls
* `@get-commands` (or `@commands`, `@help`) — Display full command manual (requires `@otp-login` / `@unlock` first while locked).
* `@clear` — Clear active conversation context window.
* `exit` / `quit` — Save state and exit application.

---

## 📂 Project Structure

```
.
├── index.js                  # Main CLI entry point with interactive REPL & streaming
├── package.json              # Bun dependencies & scripts
├── starter.sh                # Smart startup wrapper script (self-healing)
├── install.sh                # Universal multi-platform installer script
├── install_ubuntu.sh         # Dedicated Ubuntu Desktop/Server/VPS installer script
├── Dockerfile                # Portable Bun + Node + Python + ffmpeg runtime image
├── docker-compose.yml        # App service (+ optional bundled `ollama` profile) with volumes & ports
├── dockerize.sh              # Build/run/up/down/logs/shell/clean helper for Docker & Compose
├── docker-entrypoint.sh      # Container entrypoint: syncs env into settings, patches, starts CLI
├── portainer-stack.yml       # Portainer stack (named volumes only; see PORTAINER.md)
├── PORTAINER.md              # Portainer setup guide (build/push, deploy, volumes, troubleshooting)
├── .env.example              # Template for OLLAMA_HOST, API keys, ports, bridge + mention toggles
├── .dockerignore             # Keeps secrets, DBs, logs and auth out of the image
├── patch_onnx.js             # Idempotent node_modules patches (log-silencing, sharp/canvas fallbacks; `bun run patch:check` verifies)
├── app_settings.json         # Active application configuration
├── memory.json               # Memory persistence store (auto-synced with SQLite; global pool with per-row language)
├── memory.<lang>.json       # Per-language memory pools, e.g. memory.en.json / memory.lt.json (auto-synced, auto-created per ISO 639 code)
├── tasks.json                # Kanban tasks persistence store
├── characters.json           # Character profiles & system prompts
├── babyagi.ts                # BabyAGI CLI entry (`bun run babyagi -- "<objective>"`)
├── md_to_pdf.py / pdf_to_md.py # Python note↔PDF helpers
├── chat_sessions.json        # Chat sessions store
├── data/
│   └── bot.db                # SQLite database for persistent memories, knowledge, and learning logs
├── whatsapp_qr.html          # Web view for WhatsApp QR code & pairing
├── voice_interface.html      # Dagowan real-time voice web UI (security panel + commands browser)
├── dashboard.html            # OpenWebUI-style dashboard chat (model/persona pickers, sessions, settings panel, avatar/AI Friend fan-out)
├── avatar.html               # Lipsync avatar popup served at /avatar (🎃 pumpkin theme, server TTS + browser-voice fallback)
├── aifriend.html             # AI Friend avatar popup served at /aifriend (vanilla-JS port of ai_bud_pro LiveCharacter3D.tsx)
├── aifrienddash.html         # AI Friend dashboard served at /aifrienddash (vanilla-JS port of ai_bud_pro main.tsx → dashboard REST API)
├── chrome-extension/         # MV3 companion sidebar widget v1.1.1 (chat + locks/unlocks + Ask-Dagowan context menu)
│   ├── manifest.json         # MV3 manifest (side panel + popup fallback + service worker, 127.0.0.1:8767 host perms)
│   ├── sidepanel.html / sidepanel.js # Sidebar widget: full-height WS client (text_prompt → llm_complete), lock badge, PIN/OTP inputs
│   ├── popup.html / popup.js # Same client as a popup fallback (pre-sidePanel Chrome)
│   ├── background.js         # Toolbar click opens side panel; "Ask Dagowan" context menu → stash → panel auto-send
│   ├── content.js            # Page selection helper
│   └── README.md             # Extension install + usage
├── backups/                  # Exported JSON backups
├── projects/                 # Ollama CLI agent output directory
├── notes/                    # Workspace Markdown notes directory
├── pdfs/                     # Output directory for generated PDF files
├── whatsapp_bridge/          # Node.js Baileys web socket bridge for WhatsApp
│   ├── index.js              # Baileys socket + group mention pre-filter + status server
│   ├── mentions.js           # CJS mirror of src/whatsapp_mentions.js (bridge pre-filter)
│   ├── package.json          # Isolated bridge deps (installed via npm --prefix)
│   └── package-lock.json     # Pinned bridge dependency tree
├── ollama_cli/               # High-performance local AI agentic coding CLI toolset
└── src/
    ├── db/
    │   ├── schema.js         # SQLite database schema (memories incl. character_id + language, knowledge, logs, rules)
    │   └── database.js       # SQLite connection manager, query helpers & character_id/language migration
    ├── language.js           # Open-ended multilanguage layer: detection (scripts + stopwords, any ISO 639 code), translation bridge, per-language files
    ├── language.test.js      # Multilanguage layer tests (pools, scoping, bridge, scripts)
    ├── memory.js             # Character- + language-scoped MemoryStore with TF-IDF retrieval, bridge recall, superseding, & JSON sync
    ├── knowledge.js          # Versioned KnowledgeStore & KnowledgeRetriever
    ├── learning.js           # Incremental Learning Pipeline (heuristic & LLM extraction)
    ├── config.js             # Settings manager, export & import settings
    ├── tasks.js              # Kanban task board & reminder manager
    ├── proactive.js          # Proactive chat timers & idle check-in manager
    ├── characters.js         # Character profile manager & system prompt templates
    ├── logger.js               # Prompt/error logging to logs/
    ├── model_selection.js      # Single shared-model resolution across all features
    ├── agentic.js              # Legacy web action dispatcher (YouTube/Google/Giphy/Spotify open & search)
    ├── sessions.js           # Chat sessions manager & character-scoped cross-session context retrieval
    ├── workspace.js          # Workspace note file reader & relevance search
    ├── chat_context.js       # Parallel chat-context assembly (memories+knowledge+sessions via Promise.all + workers)
    ├── pdf_utils.js          # Pure JavaScript Markdown-to-PDF & PDF-to-Markdown tools (parallel workers for batch)
    ├── providers.js          # Unified Multi-Provider LLM engine (Ollama, Gemini, Claude, Grok, Mistral, OpenAI)
    ├── ollama_ephemeral.js     # Ephemeral one-shot Ollama inference via bun-ollama CLI (@ephemeral/@one-shot, default ON; RAM freed per turn)
    ├── ollama_ephemeral.test.js # Ephemeral one-shot unit tests (discovery, sanitizing, toggle parsing; no network/model)
    ├── one_shot.js             # One-shot CLI (`bun run ask "<prompt>" [--model <name>]`, model from settings)
    ├── audio.js              # 100% Local STT (Whisper) & Local TTS (MMS-TTS) audio models
    ├── voice_socket.js       # Real-Time WebSocket Voice Bridge & Server
    ├── dashboard.js          # OpenWebUI-style dashboard server (/avatar, /aifriend, /aifrienddash, /api/* REST + TTS)
    ├── dashboard.test.js       # Dashboard flag/port/chat/lock unit tests (no network)
    ├── telegram.js           # Telegram bot runner integration with voice attachment support
    ├── whatsapp.js           # WhatsApp HTTP bridge server integration (group gate + DM mention router)
    ├── whatsapp_mentions.js  # Shared @character-name matching/strip helpers (server side)
    ├── persona_bridge.js       # On-demand Telegram polling bridge (active-only boot, @wake/@sleep, idle auto-sleep sweeper)
    ├── persona_bridge.test.js  # Persona polling bridge unit tests (mocked runners, no network)
    ├── ollama_coding.js      # Ollama CLI agent & toolset integration bridge
    ├── opencli.js            # API-driven OpenAI coding agent (@opencli): jailed tool loop + owner gating + audit log
    ├── opencli.test.js       # OpenCLI jail/gating/guard unit tests (no network)
    ├── opencode.js           # External opencode CLI runner (@opencode/@opencode-model/@opencode-setup/@opencode-setup-auto-allow): explicit project path + user/opencode model + guided setup + auto-allow permissions + audit log
    ├── opencode.test.js      # opencode config/gating/path/model/parse/setup unit tests (no network)
    ├── browser.js            # Agentic local-browser service (visible window, YouTube/Spotify search/click/play, blog editors, read, shot)
    ├── browser.test.js       # Browser allowlist/URL-helper unit tests (no live browser needed)
    ├── play_api.js           # Official-API-first playback (YouTube Data API, Spotify Web API) + Chromium fallback
    ├── play_api.test.js      # Playback API unit tests (mocked fetch, no network/Chromium)
    ├── blog_api.js           # Official-API-first blog drafts (WordPress REST + XML-RPC fallback, Blogger v3) + Chromium editor fallback
    ├── blog_api.test.js      # Blog draft API/parser unit tests (mocked fetch, no network/Chromium)
    ├── factcheck_api.js      # Fact-checking (@fact-check): Semantic Scholar papers + Gemini verdict (mocked-fetch tests)
    ├── factcheck_api.test.js # Fact-check API/parser unit tests (mocked fetch, no network)
    ├── needle.js             # On-device routing/extraction/embeddings via cactus-needle (spawns needle_bridge.py)
    ├── needle_bridge.py      # Stdin/stdout Python bridge to cactus-needle (status/complete/extract/embed)
    ├── needle_daemon.py      # Persistent stdio daemon: warm turns skip ~10 s startup (supervised by needle.js)
    ├── needle.test.js        # Needle parser/formatter/bridge unit tests (mocked spawn, no model/network)
    ├── blogger_auth.js         # Google OAuth loopback flow for Blogger API (`@blogger-auth`)
    ├── blogger_auth.test.js    # Blogger OAuth unit tests (mocked, no network)
    ├── cast/                   # Bun-only TV cast (Castor-style): DLNA + Chromecast + DIAL YouTube
    │   ├── caster.js           # Orchestrator (scan → extract → probe → relay → cast) + shared @cast parser
    │   ├── dlna.js             # SSDP discovery + SOAP AVTransport (SetAVTransportURI/Play/Stop/Pause)
    │   ├── castv2.js           # CastV2 client (node:tls + minimal protobuf) + YouTube URL helpers
    │   ├── mdns.js             # mDNS _googlecast discovery (compression-aware DNS parser)
    │   ├── dial.js             # DIAL launches (native YouTube app) over plain HTTP
    │   ├── serve.js            # Bun.serve LAN relay: Range proxy + ffmpeg transcode pipe
    │   ├── probe.js            # ffprobe inspect → direct vs transcode decision
    │   ├── extract.js          # Headless Chromium page → stream sniffing + ranking
    │   ├── cast.test.js        # DLNA/extract/probe/parser unit tests (no network)
    │   └── chromecast.test.js  # CastV2/mDNS/DIAL/YouTube unit tests (synthetic packets)
    ├── babyagi_integration.ts  # BabyAGI framework bridge (provider/model wiring)
    ├── babyagi/                # Bun-native BabyAGI loop (core, packs, db, types)
    ├── incremental_learning.test.js # Memory/knowledge/learning pipeline tests
    ├── ollama_coding.test.js   # Coding-agent file/project tool tests
    ├── voice_socket.test.js    # Voice bridge integration tests: turns, interrupts, @ command dispatch (no network)
    ├── utils/
    │   ├── memoize.js          # Generic memoize/memoizeAsync (LRU + TTL) for pure hot paths
    │   ├── memoize.test.js     # Memoisation unit tests (sync/async + project integrations)
    │   ├── concurrency.js      # CPU-bounded mapWithConcurrency/chunking/worker-count helpers
    │   ├── retrieval_worker.js # worker_threads entry: memory/knowledge/session chunk scoring
    │   ├── parallel_retrieval.js # Threshold-gated parallel scoring with sync fallback
    │   ├── pdf_worker.js       # worker_threads entry: single-file md-to-pdf / pdf-to-md
    │   ├── pdf_parallel.js     # Bounded parallel PDF render/extract helpers
    │   └── threading.test.js   # Threading unit tests (worker equivalence + fallbacks)
    └── commands.js           # @ commands dispatcher & help manual
```

---

## 🔧 Troubleshooting & Tips

### ⚠️ `LLM Error: Unable to connect. Is the computer able to access the url?`
This occurs when the active model is set to local Ollama (`http://127.0.0.1:11434`), but the Ollama daemon is not running:
1. **Start Ollama daemon**:
   ```bash
   ollama serve &
   ```
2. **Download model**:
   ```bash
   ollama pull llama3
   ```
3. **Or switch to Cloud LLMs**:
   ```text
   @set-api-key gemini YOUR_KEY
   @model gemini-2.5-flash
   ```

### 🎭 Simulation replies show only `[sim:<name>] archived` with no answer
Fixed: the CLI simulation path omitted the current turn from the model payload, so the model answered stale history and alternate turns came back empty. Update to the latest version. If stuck, end the simulation with `@simulation-end` and start a new turn.

### 📱 WhatsApp & Telegram DNS in PRoot-Distro
In PRoot-Distro, if external API calls fail, check `/etc/resolv.conf`:
```bash
echo "nameserver 8.8.8.8" > /etc/resolv.conf
```

---

---

## 🔐 Public Release Notes (credentials & lock state)

This public repository ships **without any credentials**:

* `app_settings.json` contains the full current settings schema with all
  secrets empty (`*_api_key`, `*_secret`, `telegram_token`,
  `wordpress_*`, `blogger_*`, `spotify_*`, `youtube_api_key`,
  `brave/tavily` keys) and **no security PIN or OTP enrolled**
  (`security_pin_hash` / `otp_secret` are empty), so the project is
  **not locked** — all `@` control commands work immediately after setup.
* `characters.json` ships with demo personas and no Telegram tokens.
* Machine-specific runtime files are gitignored and never committed:
  `.env`, `mcp_servers.json`, `client_secret_*.json`, `data/*.db`,
  `logs/`, `tmp/`, `node_modules/`, WhatsApp `auth/`.
* Configure your own keys after install via `.env`
  (see `.env.example`) or in-app `@set-api-key` commands —
  see "🔑 3. Configure API Keys" above.

> Known pre-existing issue: `bun test` reports 1 failure in
> `src/blogger_auth.test.js` ("loadOAuthClient ... rejects junk").
> It fails identically upstream and does not affect runtime behaviour.

## 📜 License

MIT License © Andrius Pratusis
