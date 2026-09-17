# OpenSourceAPIHelper — Build, Run, Service (operational guide)

The docs/spec (design) lives in `README.md` and `docs/`. This file is the
operational guide for the **working implementation**.

## Requirements

- Node.js **>= 22.5** (uses Node's built-in `node:sqlite` — no native rebuild).
- npm (workspaces).

## 1. Install

```bash
npm install
```

## 2. Run in development (server + client together)

```bash
npm run dev
```

- Server: `http://127.0.0.1:8787`
- Vite client: the URL Vite prints (typically `http://localhost:5173`).

The Vite dev server proxies `/api` and `/v1` to the daemon.

## 3. Build the client + run headless (single daemon serves the UI)

```bash
npm run build      # -> client/dist
npm start          # daemon on http://127.0.0.1:8787, serves the built UI
```

## 4. Environment overrides

| Var | Default | Meaning |
|---|---|---|
| `OSAH_DATA_DIR` | `%APPDATA%\OpenSourceAPIHelper` (Win) or `~/Library/Application Support/OpenSourceAPIHelper` (mac) | runtime state: sqlite, `.masterkey`, logs |
| `OSAH_PORT` | `8787` | loopback port |
| `OSAH_HOST` | `127.0.0.1` | bind address (**keep loopback**) |
| `OSAH_DB` | `osah.sqlite` | sqlite filename |
| `OSAH_TOKEN` | unset | optional `X-OSAH-Token` bearer check (defense-in-depth) |

## 5. Install as an OS service (Req 10)

**Windows** (run from an **admin** PowerShell/bash):

```bash
npm run service:install     # creates a LocalSystem "OSAH" service running the daemon
npm run service:uninstall   # stops + removes it
```

**macOS** (LaunchAgent):

```bash
sed "s|__ROOT__|/absolute/path/to/OpenSourceAPIHelper|g" \
  scripts/service/macos-launchagent.plist \
  > ~/Library/LaunchAgents/com.osahhelper.daemon.plist
launchctl load ~/Library/LaunchAgents/com.osahhelper.daemon.plist
```

Logs: `%OSAH_DATA_DIR%\osah.log`.

## 6. API surface (what the UI consumes)

| Method & path | Purpose |
|---|---|
| `POST /api/providers` | add a provider (baseUrl + key or `keyEnv`) |
| `GET/PUT/DELETE /api/providers/:id` | list (masked) / merge-on-edit / remove |
| `POST /api/providers/:id/test` | validate key → **auto-discover + register models** |
| `POST /api/providers/:id/activate` | set the provider the `/v1` proxy uses |
| `GET /api/models` | registered models across providers |
| `POST /api/chats`, `GET/DELETE /api/chats/:id` | multi-chat sessions + history |
| `POST /api/chats/:id/stream` | SSE chat (events: `start,reasoning,delta,finish,done`) |
| `GET /api/memory/search?q=` | FTS reference search over all chats (Req 3) |
| `GET/PUT /api/settings` | sealed (GMAC-tagged) settings |
| `/v1/models`, `/v1/chat/completions` | OpenAI-compatible **loopback proxy** to the active provider |

## Quick end-to-end smoke test (daemon running)

```bash
PORT=8790 OSAH_DATA_DIR="$(pwd)/.runtime" node scripts/dev-boot.js &   # local daemon
curl -s localhost:8790/api/health
curl -s -X POST localhost:8790/api/providers -H 'Content-Type: application/json' \
  -d '{"name":"My","baseUrl":"https://integrate.api.nvidia.com/v1","keyEnv":"GLM_API_KEY"}'
curl -s -X POST localhost:8790/api/providers/<id>/test       # discovers models
curl -s -X POST localhost:8790/api/chats -H 'Content-Type: application/json' -d '{}'
curl -s -N -X POST localhost:8790/api/chats/<id>/stream -H 'Content-Type: application/json' \
  -d '{"content":"Hi","model":"<a-model>"}'                  # SSE stream
```

## Security notes

- Keys exist only as **AES-256-GCM ciphertext** in the vault, or are referenced by
  env name (`keyEnv`). The UI, API, and logs only ever show masked forms (`sk-***…`).
- The daemon is the **only** process that unseals a key; there is no raw-config
  view/edit surface (sealed config, Req 9).
- The service binds to `127.0.0.1`. Set `OSAH_TOKEN` to require a bearer token.