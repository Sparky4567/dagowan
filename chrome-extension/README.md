# Dagowan Voice AI — Chrome Extension (Companion)

Local companion sidebar widget for the Dagowan Web UI. Talks to the same voice bridge
as `voice_interface.html` over WebSocket — no cloud, no extra server.

- **Server:** `ws://127.0.0.1:8767/ws` (configurable in the panel; served by `src/voice_socket.js` via `./starter.sh --web` / `bun run web`)
- **Scope:** the shared `web` scope — lock state is shared with the browser voice UI tab.

## Install (unpacked)

1. Start the server: `./starter.sh --web` (open `http://127.0.0.1:8767` once to verify).
2. Chrome → `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select this `chrome-extension/` folder.
3. Pin the 🎙 icon and click it — the Dagowan panel opens as a sidebar widget (stays open while you browse). Hit 🔄 inside if needed. (Chrome 114+; older builds fall back to the popup.)

## What it supports

- **Chat:** type anything or right-click selected text on any page → *Ask Dagowan about selection* (the side panel opens and auto-sends).
- **Locks / unlocks (same as Web UI):**
  - `@security-status`, `@unlock <pin>`, `@lock`, `@set-security-pin`, `@remove-security-pin`
  - `@otp-status`, `@otp-set`, `@otp-login <code>`, `@otp-lock`, `@otp-remove <code>`
  - While PIN/OTP is set, every `@` control command — including `@help` — needs `@otp-login` first, then `@unlock`. Regular chat always works.
- **Supported commands:** the side panel talks to the same dispatcher as Telegram/WhatsApp — `@youtube-play`/`@play`, `@spotify-play`, `@blog`, `@astro-post`, `@fact-check`, `@browser-*`, `@cast-*`, `@make`, `@create-file`, `@remember`, tasks, `@stats`, `@models`, `@sessions`, and more (full list in `@help` / `README.md` → `@ Commands Reference`). Quick buttons for `@help`, `@sessions`, `@stats`, `@models`, `@get-tasks`; anything else can be typed.
- **Lock badge (🔒/🔓):** tracks PIN/OTP state from server replies (including the dynamic `security_unlock_minutes` wording) and re-checks `@security-status` whenever the panel becomes visible again.

## Files

- `manifest.json` — MV3 (side panel + popup fallback + service worker + context menu + content helper)
- `sidepanel.html` / `sidepanel.js` — sidebar widget: full-height WS client (`text_prompt` → `llm_complete`), lock badge, PIN/OTP inputs
- `popup.html` / `popup.js` — same client as a popup fallback (pre-sidePanel Chrome)
- `background.js` — toolbar click opens the side panel; *Ask Dagowan* context-menu → stash → panel auto-send
- `content.js` — selection helper
- `icons/` — placeholder icons (replace with your own art anytime)
