# Dagowan on Portainer

Run the dockerized app from the Portainer UI using `portainer-stack.yml`
(named volumes only — the relative `./notes`-style bind mounts in
`docker-compose.yml` have no host project directory under Portainer, so they
are replaced here with named volumes).

What you get:

| Port | URL | Purpose |
|---|---|---|
| `8765` | `http://<host>:8765` | WhatsApp HTTP bridge (`/chat`, `/health`) |
| `8766` | `http://<host>:8766` | WhatsApp QR / pairing view (`/qr`, `/pair`, `/status`) |
| `8767` | `http://<host>:8767` | Dagowan voice Web UI + WebSocket (`/ws`) |
| `8901` | — | TV cast relay (`/stream`) |
| `11434` | — | Bundled Ollama, only if you enable it |

## 1. Prerequisites

- Portainer CE connected to a Docker environment (Docker 24+, Compose v2).
- A model backend: Ollama on the Docker host (`ollama serve`), the bundled
  Ollama service, or cloud keys only (`OPENAI_API_KEY` / `GEMINI_API_KEY` /
  `CLAUDE_API_KEY` / `GROK_API_KEY`).
- The stack file `portainer-stack.yml` from this repo.

## 2. Build or point at an image

Pick one:

**A. Repository stack (Portainer builds the image).** No registry needed.
You deploy straight from this git repo; Portainer uses the `build: .` block.

**B. Prebuilt image (web-editor paste).** The web editor has no build
context, so build and push once from any machine with Docker:

```bash
docker build -t ghcr.io/<user>/dagowan:latest .
docker push ghcr.io/<user>/dagowan:latest
```

Then in your pasted stack: comment out `build: .` and set
`image: ghcr.io/<user>/dagowan:latest`.

## 3. Deploy

1. Portainer -> Stacks -> Add stack, name it `dagowan`.
2. Option A: select Repository, enter the repo URL/branch, compose path
   `portainer-stack.yml`. Option B: select Web editor and paste the contents
   of `portainer-stack.yml` (with the image change from section 2).
3. Environment variables (Advanced -> Environment, or pre-fill before
   deploy). Minimum useful set:

   | Variable | Example | Notes |
   |---|---|---|
   | `OLLAMA_HOST` | `http://host.docker.internal:11434` | Default; host-side Ollama. Bundled: `http://ollama:11434` |
   | `GEMINI_API_KEY` | `AIza...` | Optional cloud model key (any provider key works) |
   | `WHATSAPP_ENABLED` | `0` / `1` | WhatsApp is **opt-in**; default off, no QR spam |
   | `WHATSAPP_PHONE` | `37060000000` | Country code + number; enables WhatsApp + numeric pairing |
   | `WHATSAPP_QR_MODE` | `auto` | `auto` (Termux = numeric code, else QR) `\| qr \| pairing \| off` |

   Full variable list with comments: `.env.example`.
4. Deploy the stack. Watch Containers -> `dagowan-app` (or your stack's
   container) -> Logs until you see the CLI banner and
   `[entrypoint] Starting: bun run index.js --web`.

## 4. First-run checklist

- **Health:** container state Running (the image healthchecks
  `:8765/health`, falling back to `:8767/`).
- **Web UI:** open `http://<docker-host>:8767`.
- **Model:** host Ollama must be serving (`ollama serve` on the host pulls
  `host.docker.internal` via `extra_hosts`). Bundled Ollama: pull a model
  once from its console — `ollama pull llama3` — then set
  `OLLAMA_HOST=http://ollama:11434` and redeploy. Cloud-only: set a key and
  switch in-app (`@model gemini-2.5-flash`).
- **WhatsApp (optional):** set `WHATSAPP_ENABLED=1` or `WHATSAPP_PHONE` and
  redeploy (Stack -> Editor -> Update the stack). Open
  `http://<docker-host>:8766/qr` to scan, or fetch a numeric code:
  `POST http://<docker-host>:8766/pair {"phone": "37060000000"}`
  (in-app: `@whatsapp-pair 37060000000`). Session persists in
  `dagowan-wa-auth`.
- **Interactive CLI:** the main process is the CLI. From the Docker host run
  `docker attach <container>`; Portainer's Console button opens a *new*
  shell (`/bin/bash`), which is for file/shell work, not the CLI prompt.

## 5. Data and backups

All state lives in named volumes (Volumes view in Portainer):

| Volume | Content |
|---|---|
| `dagowan-data` | SQLite (`bot.db`), browser profile |
| `dagowan-wa-auth` | Linked WhatsApp session (delete to unlink) |
| `dagowan-config` | `app_settings.json`, `characters.json`, `memory.json`, `chat_sessions.json`, `tasks.json` (entrypoint-synced, survives rebuilds) |
| `dagowan-notes/pdfs/projects/backups/logs/tmp` | Working files, formerly host bind mounts |

- Browse/download files via the volume details in Portainer.
- Portable backup: in-app `@export-settings` (lands in `dagowan-backups`),
  then download it from the volume.
- Reset WhatsApp link without touching anything else: `POST /reset` on
  port 8766, or delete the `dagowan-wa-auth` volume and recreate.

## 6. Update and redeploy

- Repository stack: Pull and redeploy (toggle Repull image / Rebuild).
- Prebuilt image: push a new tag, Stack -> Editor -> Update the stack
  (enable Repull). Volumes are untouched, so settings and sessions survive.
- Duplicate the stack for a second instance: change the stack name and the
  published ports to avoid collisions.

## 7. Troubleshooting

| Symptom | Fix |
|---|---|
| Container `unhealthy` | Check Logs; confirm one backend answers (Ollama reachable or cloud key set + model selected) |
| Web UI unreachable | Verify published `8767` and host firewall; servers bind `0.0.0.0` in-container by design |
| `host.docker.internal` not resolving | Only auto-resolves on Docker Desktop; on Linux the stack's `extra_hosts: host-gateway` covers it. On a *remote* Docker host, set `OLLAMA_HOST` to the LAN URL of Ollama |
| QR codes appear unasked | WhatsApp defaults off; ensure `WHATSAPP_ENABLED` is unset/`0` and `WHATSAPP_PHONE` empty, then Update the stack |
| Can't scan QR (Termux display) | `WHATSAPP_QR_MODE=pairing` (or `auto` on Termux) + `WHATSAPP_PHONE`, then use the 8-digit code via `/pair` or `@whatsapp-pair` |
| Bundled Ollama never starts | Portainer deploys without compose profiles. Deploy Ollama as its own stack: image `ollama/ollama:latest`, port `11434:11434`, volume `ollama-data:/root/.ollama`, then set app `OLLAMA_HOST` to it |
| TV discovery finds nothing | SSDP/mDNS multicast doesn't cross bridge networking; pin the TV (`@set-cast-device 192.168.0.3`) or use host networking on Linux |
| Stack editor rejects the file | Web-editor pastes have no build context — use option B (prebuilt image, `build:` commented out) |

See also: `README.md` (full Docker + `dockerize.sh` reference),
`docker-compose.yml` (host CLI workflow with bind mounts).
