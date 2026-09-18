# OpenSourceAPIHelper

A deliberately slim, self-hosted **LLM provider API-key manager + chat client** with memory, multi-chat, key redaction, and an installable OS service. It is **not** a full Hermes clone — it is a focused, single-machine tool for managing many OpenAI-compatible keys behind one UX and one loopback endpoint.

## Project Details

- **Name**: OpenSourceAPIHelper
- **Version**: 1.0.0
- **License**: MIT (implicit)
- **Primary Platform**: Windows (with macOS support)
- **Architecture**: Two-process design (service/daemon + Electron UI client)
- **Core Technologies**:
  - Server: Node.js >=22.5, Express, built-in `node:sqlite` (WAL + FTS5)
  - UI: React 18, Vite, TypeScript, Zustand (state management)
  - Desktop: Electron (main + preload)
  - Security: AES-256-GCM vault, key indirection via `key_env`, redaction everywhere
- **Persistence**: SQLite database (WAL mode) with FTS5 virtual table for full-text memory search
- **Service Install**: Windows Service (`sc.exe`) / macOS LaunchAgent (`launchctl`)
- **API Surface**: REST + SSE chat + OpenAI-compatible `/v1` loopback proxy

## Repository Structure

```
OpenSourceAPIHelper/
├── client/                 # React (Vite) SPA – UI
│   ├── src/
│   │   ├── api/            # Typed fetch wrapper + SSE helper
│   │   ├── lib/            # Markdown renderer
│   │   ├── pages/          # Dashboard, Chat, History, Settings
│   │   ├── App.tsx
│   │   ├── main.tsx
│   │   ├── store.ts        # Zustand store
│   │   └── styles.css
│   ├── dist/               # Built output (gitignored)
│   ├── index.html
│   ├── package.json
│   ├── tsconfig*.json
│   └── vite.config.ts
├── electron/               # Thin Electron wrapper
│   ├── main.js             # spawns service, creates window
│   ├── preload.js          # exposes service host/port to renderer
│   └── package.json
├── server/                 # Node.js Express daemon (the service)
│   ├── src/
│   │   ├── api.js          # REST routes (providers, models, chats, memory, settings, status)
│   │   ├── app.js          # Express app + static + /v1 proxy
│   │   ├── config.js       # paths, ports, env defaults
│   │   ├── crypto.js       # AES-256-GCM sealing (nonce|tag|ciphertext)
│   │   ├── db.js           # SQLite wrapper (node:sqlite) + schema + FTS triggers
│   │   ├── index.js        # entrypoint: init vault/db, start HTTP server
│   │   ├── keystore.js     # master key custody (env -> .masterkey file)
│   │   ├── openai.js       # OpenAI-compatible HTTP client (fetch) + streamChat
│   │   ├── providers.js    # provider CRUD, test→discover, activation
│   │   ├── chatstore.js    # chat + message domain + FTS index
│   │   └── util.js         # redaction + masking helpers
│   └── package.json
├── scripts/
│   ├── dev-boot.js         # loads .env via key_env, starts server (dev)
│   ├── diag-*.js           # diagnostic helpers (stream, loop, etc)
│   └── service/
│       ├── windows-service.js   # sc.exe install/uninstall (admin)
│       └── macos-launchagent.plist
├── docs/
│   ├── 01-requirements.md  # PRD – FRs/NFRs, MVP gate
│   ├── 02-hld.md           # High-Level Design – two-process, data flows
│   ├── 03-lld.md           # Low-Level Design – Zod schemas, API contracts
│   ├── 04-architecture.md  # Architecture – diagrams, trust boundaries, ADRs
│   ├── 05-phases.md        # Phases 0-5 with DoD, dependencies, risks
│   └── 06-tech-doc.md      # Tech doc – stack, threat model, OWASP, tests
├── .gitignore
├── README.md               # this file
└── USAGE.md                # operational guide (build, run, service)
```

## Build & Run Instructions

### Prerequisites
- **Node.js >= 22.5** (uses Node's built-in `node:sqlite` – no native rebuild needed)
- **npm** (workspaces)

### 1. Install Dependencies
```bash
npm install
```

### 2. Development Mode (server + Vite client together)
```bash
npm run dev
```
- Server: http://127.0.0.1:8787 (API)
- Vite client: URL printed by Vite (usually http://localhost:5173)
- The Vite dev server proxies `/api` and `/v1` to the daemon.

### 3. Production Build (single daemon serves UI)
```bash
npm run build      # → client/dist
npm start          # daemon on http://127.0.0.1:8787, serves built UI
```

### 4. Install as an OS Service (Req 10)

#### Windows (run from an **admin** PowerShell or bash)
```bash
npm run service:install   # creates LocalSystem service "OSAH"
npm run service:uninstall # stops + removes it
```

#### macOS (LaunchAgent)
```bash
sed "s|__ROOT__|/absolute/path/to/OpenSourceAPIHelper|g" \
  scripts/service/macos-launchagent.plist \
  > ~/Library/LaunchAgents/com.osahhelper.daemon.plist
launchctl load ~/Library/LaunchAgents/com.osahhelper.daemon.plist
```
Logs go to `$OSAH_DATA_DIR/osah.log`.

### 5. Environment Overrides
| Variable | Default | Meaning |
|---|---|---|
| `OSAH_DATA_DIR` | `%APPDATA%\OpenSourceAPIHelper` (Win) or `~/Library/Application Support/OpenSourceAPIHelper` (mac) | Runtime state: SQLite, `.masterkey`, logs |
| `OSAH_PORT` | `8787` | Loopback port |
| `OSAH_HOST` | `127.0.0.1` | Bind address (keep loopback only) |
| `OSAH_DB` | `osah.sqlite` | SQLite filename |
| `OSAH_TOKEN` | unset | Optional `X-OSAH-Token` bearer check (defense-in-depth) |

## Capabilities (mapped to requirements)

- **Settings tab** – add/manage keys + endpoints for 35+ providers + any custom OpenAI-compatible endpoint. **(Req 1)**
- **Test-on-add** – enter key + URL → **Test** → on success models are discovered and become selectable immediately. **(Req 6)**
- **Chat client** – streaming chat, multiple concurrent chats, per-chat model picker from validated list. **(Req 2, 4, 5)**
- **Memory** – chats persist; FTS reference search over past chats (embeddings opt-in later). **(Req 3)**
- **Durability** – transactional SQLite store; nothing lost on restart/crash. **(Req 7)**
- **Redaction + sealed config** – keys never visible; config file encrypted/sealed; no file-edit or file-view surface. **(Req 8, 9)**
- **Always-on service** – installed as Windows Service / macOS LaunchAgent that keeps app + API + proxy running in background. **(Req 10)**
- **Cross-platform** – Windows (primary) and macOS. **(Req 11)**
- **Consume anywhere** – OpenAI-compatible `/v1` proxy exposes the active key to any client (QA test suites get stable, key‑free loopback URL). **(Implied)**

## Documentation (v2)

| Doc | What it contains |
|---|---|
| [`docs/01-requirements.md`](docs/01-requirements.md) | **PRD** – problem, goals/non-goals, FR/NFR, v2 MVP acceptance gate (12 items) |
| [`docs/02-hld.md`](docs/02-hld.md) | **HLD** – two‑process (service + UI) context, components, data flows, service operation |
| [`docs/03-lld.md`](docs/03-lld.md) | **LLD** – repo layout, Zod schemas, full API contract, validation/chat/memory/proxy/vault detail, installers |
| [`docs/04-architecture.md`](docs/04-architecture.md) | **Architecture** – diagrams, trust boundaries, rationales, ADR‑001..012 |
| [`docs/05-phases.md`](docs/05-phases.md) | **Phases** – Phases 0‑5 with DoD, dependency graph, risk register, execution order |
| [`docs/06-tech-doc.md`](docs/06-tech-doc.md) | **Tech doc** – stack, threat model (8 narratives), OWASP baseline, test strategy, evolution |

All FR/NFR IDs trace across the set: feature → component → interface → ADR → phase → security/test control.

## Status

Docs v2 (design) **and** a working implementation both exist. The server (Express + `node:sqlite` + AES‑GCM vault + `/v1` proxy), React client, and Electron wrapper are built and verified against a live provider stream. See [`USAGE.md`](USAGE.md) for install / run / OS‑service steps, or [`docs/05-phases.md`](docs/05-phases.md) for what remains (Phase 4 packaging / installers)."# OpenSourceAPIHelper" 
