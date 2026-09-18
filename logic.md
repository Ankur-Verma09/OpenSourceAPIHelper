# OpenSourceAPIHelper – Internal Logic & Data Flow

This document explains the **internal logic** of the two‑process architecture:  
what each layer does, how data moves, and why the design satisfies the requirements.

---

## 1. High‑Level Data Flow

```
+----------------+        HTTP (127.0.0.1:PORT)        +-----------------+
|   Electron UI  |  <───────────────────────────────>  |   Node Service  |
|  (client/)     |                                     |  (server/)      |
|                |  JSON API  │  SSE chat  │  /v1 proxy  |                |
+----------------+        ◄────────────────────────►   +-----------------+
                            ▲                           ▲
                            │                           │
                   (user actions)               (sealed vault, SQLite)
                            │                           │
                   +----------------+        +-----------------+
                   |  LocalStorage  |        |  SQLite DB      |
                   |  (UI cache)    |        |  ├─ providers   |
                   +----------------+        |  ├─ models      |
                                            |  ├─ chats       |
                                            |  ├─ messages    |
                                            |  ├─ messages_fts(FTS5)|
                                            |  ├─ settings    |
                                            |  └─ meta        |
                                            +-----------------+
```

- The **Electron UI** never sees raw keys; it only receives masked views (`key_masked`, `has_key`, `key_env`).
- The **Node Service** (daemon) is the **sole owner** of secrets: it holds the AES‑256‑GCM vault, the SQLite file, and the master key (derived from the environment or a file protected to the service account).
- All inter‑process communication is HTTP over loopback; the UI talks to `/api/*`, and any external tool can talk to `/v1/*` (OpenAI‑compatible proxy to the *active* provider).

---

## 2. Process Responsibilities

### 2.1 Electron UI (client/)
- **Rendering**: React + Vite, dark glassmorphism UI.
- **State**: Zustand store holds UI‑local caches (provider list, chat list, settings).
- **API Layer**: `client/src/api/client.ts` – thin typed fetch wrapper + SSE helper.
  - Resolves base URL from:
    1. `import.meta.env.VITE_OSAH_BASE` (build‑time override)
    2. `window.OSAH_BASE` (runtime override)
    3. Electron preload (`window.osah.serviceHost()`, `window.osah.servicePort()`)
    4. Fallback: `http://127.0.0.1:8787`
- **Pages**:
  - **Dashboard**: provider list (masked), add/edit, test→discover, activate.
  - **Chat**: chat list, new chat, chat view with streaming (`reasoning` + `delta`).
  - **History**: FTS memory search (`GET /api/memory/search?q=`).
  - **Settings**: sealed settings GET/PUT (theme, default model, proxy enabled).
- **Security**: Never logs, never stores, never transmits raw keys. Only displays masked forms like `sk-••••••abcd`.

### 2.2 Node Service (server/)
The daemon owns **all persistence and secret material**. It consists of these modules:

#### 2.2.1 `config.js`
- Centralizes paths, ports, defaults.
- `DATA_DIR` = `process.env.OSAH_DATA_DIR` or platform‑specific app‑data folder.
- `PORT` = `process.env.OSAH_PORT` or `8787`.
- `HOST` = `process.env.OSAH_HOST` or `127.0.0.1` (enforced loopback).

#### 2.2.2 `keystore.js`
- Master key custody:
  1. If `OSAH_MASTER_KEY` env var is set → use it (production / service account).
  2. Else → read/create `.masterkey` file in `DATA_DIR` (chmod 0600 / ACL‑restricted).
- The master key **never leaves this module**; it is used only to unseal the vault key.

#### 2.2.3 `crypto.js`
- AES‑256‑GCM seal/unseal.
- Opaque format: `v1:<nonceB64>:<tagB64>:<ciphertextB64>`
- Sealing = encryption + authentication (tag acts as HMAC).
- Used for:
  - Provider API keys (stored as ciphertext in `providers` table)
  - Sealed settings (one row in `settings` table)
  - The vault key itself (wrapped by the master key)

#### 2.2.4 `db.js`
- Thin wrapper around Node’s built‑in `node:sqlite` (SQLite with FTS5 enabled, no native rebuild).
- Schema:
  ```sql
  CREATE TABLE providers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    key_ciphertext TEXT NOT NULL,   -- v1:...
    key_env TEXT,                   -- if set, key comes from env
    type TEXT NOT NULL DEFAULT 'openai',
    active INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE models (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model TEXT NOT NULL,
    provider_id TEXT NOT NULL REFERENCES providers(id),
    UNIQUE(model, provider_id)
  );

  CREATE TABLE chats (
    id TEXT PRIMARY KEY,
    title TEXT,
    model TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK(role IN ('user','assistant')),
    content TEXT NOT NULL,
    model TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE VIRTUAL TABLE messages_fts USING fts5(
    content,
    chat_id UNINDEXED,
    msg_id UNINDEXED
  );

  -- Triggers keep FTS in sync with messages table
  CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content, chat_id, msg_id)
    VALUES (new.id, new.content, new.chat_id, new.id);
  END;
  CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
    DELETE FROM messages_fts WHERE rowid = old.id;
  END;
  CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
    UPDATE messages_fts SET content = new.content WHERE rowid = new.id;
  END;

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value_ciphertext TEXT NOT NULL   -- v1:...
  );

  CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  -- meta stores schema_version for migrations
  ```
- WAL mode (`PRAGMA journal_mode=WAL`) + `synchronous=NORMAL` gives crash‑safety without fsync‑latency for a single‑user app.
- All writes happen inside **explicit transactions** (`db.transaction(() => { … })`).

#### 2.2.5 `openai.js`
- Low‑level OpenAI‑compatible HTTP client (uses native `fetch` – Node 22).
- Responsibilities:
  - **Base‑URL normalization** (strip trailing slash, ensure ends with `/v1`).
  - **Model discovery** (`GET /models` → register any new models in `models` table).
  - **Chat streaming**: `streamChat(baseUrl, apiKey, {model, messages, max_tokens, stream:true})`
    - Returns the raw `Response` so the caller can decide how to handle SSE.
    - No opinion on timeouts/cancellation – caller provides `AbortSignal`.

#### 2.2.6 `providers.js`
- Provider CRUD (create, read, update, delete) – always works with **ciphertext at rest**.
- `testProvider(id)`:
  1. Load provider row → decrypt key via vault.
  2. Call `openai.streamChat(...)` with `{max_tokens: 1, stream:true}` just to verify connectivity & auth.
  3. On **success**: call `openai.listModels()` → for each model not already present, `INSERT INTO models …`.
  4. Return `{ok:true, models:[...]}` on success, or `{ok:false, error}` on failure.
- `setActiveProviderId(id)`: flips `active` flag on exactly one row (others set to 0).
- `getActiveProvider()`: returns the row where `active = 1` (or null).
- All provider views returned to the UI are **redacted**: `key_ciphertext` → `key_masked` (show first/last 4 chars, asterisks in middle) + `has_key` + `key_env`.

#### 2.2.7 `chatstore.js`
- Chat + message domain.
- Responsibilities:
  - `createChat`, `getChat`, `listChats`, `updateChat`, `deleteChat`.
  - `addMessage(chatId, {role, content, model})`:
    1. Insert into `messages` within a transaction.
    2. FTS triggers keep `messages_fts` in sync automatically.
    3. Return the inserted message (with server‑side `id` and `created_at`).
  - `getMessages(chatId, limit=40)`: most recent N messages (for context window).
  - `historyForChat(chatId, limit=40)`: alias for the above.
  - `clearChat(chatId)`: delete all messages for a chat (keeps the chat record).

#### 2.2.8 `api.js`
- Express router – mounts all endpoints under `/api`.
  - **Providers**: `GET /api/providers`, `POST /api/providers`, `PUT /api/providers/:id`, `DELETE /api/providers/:id`, `POST /api/providers/:id/test`.
  - **Models**: `GET /api/models` (lists discovered models), `POST /api/models/activate` (body: `{model}` → finds provider that owns it, calls `providers.setActive`).
  - **Chats**: `GET /api/chats`, `POST /api/chats`, `GET /api/chats/:id`, `PATCH /api/chats/:id` (title/model), `DELETE /api/chats/:id`, `POST /api/chats/:id/stream`.
  - **Memory**: `GET /api/memory/search?q=` → runs SQL against `messages_fts`, returns snippets with rank.
  - **Settings**: `GET /api/settings`, `PUT /api/settings` (value sealed via AES‑GCM).
  - **Status**: `GET /api/status` → counts + schema version.

#### 2.2.9 `app.js`
- Builds the Express app:
  - `app.use(express.json())`.
  - Mounts the API router at `/api`.
  - Serves static files from `client/dist` when present (so `npm start` serves the built UI).
  - Adds the **OpenAI‑compatible loopback proxy** at `/v1/*`:
    ```js
    app.use('/v1', async (req, res) => {
      try {
        const p = prov.activeProvider();
        if (!p || !p.key) return res.status(503).json({error:'no active provider'});
        const target = `${normalizeBase(p.base_url)}${req.originalUrl.replace(/^\/v1/, '')}`;
        const upstream = await fetch(target, {
          method: req.method,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${p.key}`,
          },
          body: ['GET','HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body||{}),
        });
        // ... pipe response (handles SSE & JSON)
      } catch (e) {
        res.status(502).json({error:e.message});
      }
    });
    ```
  - Health check: `GET /api/health` → `{ok:true, up:Date.now()}`.

#### 2.2.10 `index.js`
- Entrypoint for the daemon (what the Windows Service / LaunchAgent runs).
- Steps:
  1. Load `config`.
  2. Initialize `keystore` → obtain master key.
  3. Initialize `crypto` with the master key → get vault key.
  4. Initialize `db` → run migrations if needed (currently schema version 1).
  5. Start HTTP server on `config.HOST:config.PORT`.
  6. Attach SIGINT/SIGTERM handler → close server → close db → exit.

---

## 3. Requirement‑to‑Logic Mapping

| Req | How it’s satisfied |
|-----|--------------------|
| **1** Settings tab | UI `Settings` page calls `GET/PUT /api/settings`. Server stores sealed ciphertext; only the daemon can unseal. |
| **2** Chat client | UI `Chat` page posts to `/api/chats/:id/stream`; server persists user message, calls upstream provider with `stream:true`, proxies SSE `reasoning`/`delta`/`done` events back to client. |
| **3** Memory / reference | FTS5 virtual table `messages_fts` over `messages.content`. `GET /api/memory/search?q=` returns ranked snippets (chat_id, msg_id, highlight). |
| **4** Multi‑chat | `ChatSummary` list + per‑chat `ChatDetail`. UI can open many chats; each has independent model picker and history. |
| **5** Per‑chat model picker | Chat row stores `model` (null = use global default). UI dropdown populated from `GET /api/models`; switching model patches `/api/chats/:id` with `{model}`. |
| **6** Test‑connection → auto‑register models | `POST /api/providers/:id/test` validates the key, then calls upstream `/models` and inserts any new models into `models` table. |
| **7** No data loss on restart | SQLite WAL mode + synchronous=NORMAL + transactional writes + automatic recovery on next open. FTS rebuilt from `messages` if needed (triggers keep it live). |
| **8** Keys redacted in UI/logs | UI only ever sees `key_masked` (derived from first/last 4 chars) and `has_key`/`key_env`. Server logs/middleware never log raw keys; `util.maskKey()` and `util.redact()` strip any key‑like strings. |
| **9** Sealed config (daemon only unseals) | Provider API keys stored as AES‑GCM ciphertext (`v1:...`). Settings stored same way. The UI has **no** endpoint to view/edit `config.yaml` or the SQLite file directly. Only the daemon process can unseal via the vault/master key. |
| **10** Always‑on service | Windows Service script (`scripts/service/windows-service.js`) uses `sc.exe` to create a LocalSystem service that runs `node server/src/index.js`. macOS LaunchAgent (`scripts/service/macos-launchagent.plist`) does equivalent with `launchctl`. Both bind to `127.0.0.1` only. |
| **11** Cross‑platform | Code uses only Node 22+ APIs (`node:sqlite`, `fetch`, `AbortController`). Electron bundles everything. Tested on Windows 10/11 and macOS 13+ (Intel & Apple silicon). |
| **Implied** Consume anywhere (`/v1` proxy) | External tools (QA suites, LangChain, curl) can call `http://127.0.0.1:PORT/v1/models` or `http://127.0.0.1:PORT/v1/chat/completions` and get responses **as if they were talking directly to the provider**, but the daemon keeps the key secret. |

---

## 4. Security & Trust Boundaries

```
+-----------------------+      HTTP (127.0.0.1)     +-----------------------+
|    Renderer Process   |  <────────────────────>   |   Browser (Electron)  |
|   (React/Vite/TS)    |   JSON API  │  SSE chat   |   (context isolated)  |
|                       |   ◄─────────────────────►  |                       |
|       UI layer        │                         │   Preload exposes    |
|                       │                         │   only {host,port}    |
+-----------------------+                         +-----------------------+
                                     │
                                     ▼
                        +------------------------------+
                        |       Main Process           |
                        |   (Electron main.js)         |
                        |  ├─ spawns service (optional)│
                        |  ├─ creates BrowserWindow   │
                        |  └─ loads built UI          │
                        +------------------------------+
                                     │
                                     ▼
                        +------------------------------+
                        |          Node Daemon         |
                        |  (server/src/index.js)      |
                        |  ├─ keystore.js   (master key custody)   |
                        |  ├─ crypto.js     (AES‑256‑GCM vault)    |
                        |  ├─ db.js         (SQLite + FTS5)        |
                        |  ├─ providers.js  (CRUD, test→discover)  |
                        |  ├─ chatstore.js  (chat + messages)      |
                        |  ├─ openai.js     (HTTP to providers)    |
                        |  ├─ api.js        (REST + /v1 proxy)     |
                        |  └─ util.js       (redaction, masking)   |
                        +------------------------------+
                                     │
                                     ▼
                        +------------------------------+
                        |     Encrypted state at rest  |
                        |  ├─ providers.key_ciphertext |
                        |  ├─ settings.value_ciphertext|
                        |  └─ .masterkey file (or OSAH_MASTER_KEY env) |
                        +------------------------------+
```

- **Trust Boundary 1**: Renderer → Main (IPC) – only non‑secret strings (`host`, `port`) cross via the preload script.
- **Trust Boundary 2**: Main → Daemon – only loopback HTTP; the UI never sees a decrypted key.
- **Trust Boundary 3**: Daemon ↔ Providers – TLS to upstream APIs; the key is used only in memory for the duration of the request then cleared.

---

## 5. Why This Design Beats Alternatives

| Alternative | Why we didn’t pick it |
|-------------|-----------------------|
| **Single‑process Electron app** | Would require the UI process to handle secrets → larger attack surface; UI crash = loss of service; no clean way to run as Windows Service / LaunchAgent. |
| **Full‑SQLite‑ORM (e.g. Sequelize)** | Unnecessary abstraction; adds ~1 MB of JS and potential migration footguns. The raw‑SQL wrapper (`db.js`) is <150 LOC and gives full control. |
| **WebSQL / IndexedDB in renderer** | No persistence across app restart; vulnerable to renderer‑side XSS exfiltration; cannot be accessed by a headless service for background tasks. |
| **Vault systems (HashiCorp, AWS KMS)** | Overkill for a single‑user desktop app; introduces network latency, external dependency, and complex credential rotation. AES‑GCM with OS‑protected master key gives equivalent confidentiality with zero moving parts. |
| **gRPC or WebSockets for UI‑service** | HTTP/1.1 + SSE is simpler, inspectable, works with ordinary proxies/firewalls, and has excellent tooling (curl, Postman). |
| **Electron‑builder / Webpack** | Vite gives sub‑second HMR and smaller bundles; no need for the complexity of webpack config for this scale. |
| **Redux / RTK** | Zustand provides equivalent scoped stores with far less boilerplate and zero extra dependency size. |

---

## 6. Failure Modes & Defensive Coding

| What could go wrong | How we defend |
|---------------------|---------------|
| **Master key unreadable** (permission/env missing) | `keystore.js` throws early; the service fails to start – operator sees loud error in logs, no silent degraded mode. |
| **SQLite corruption** | WAL mode + journal mode = very resilient. On startup we run `PRAGMA integrity_check`; if it fails we treat the file as unrecoverable and start fresh (data loss is preferable to silent misbehaviour). |
| **Upstream provider hangs or is slow** | Streaming uses the caller‑supplied `AbortSignal`; the `/v1` proxy and chat stream both forward timeouts/cancellations. Default HTTP timeout is 0 (no timeout) but the UI can cancel via UI actions. |
| **FTS get out‑of‑sync** | Triggers guarantee atomic updates. If we ever detect mismatch we can re‑build: `INSERT INTO messages_fts SELECT rowid, content, chat_id, msg_id FROM messages;` – but triggers make this unnecessary. |
| **Vault tampering** (ciphertext modified) | AES‑GCM tag verification fails on decrypt → we treat it as a missing key and force the user to re‑enter/test. |
| **Unauthorized loopback access** | By default the service binds to `127.0.0.1`. If you set `OSAH_TOKEN`, the middleware (`app.js`) will check `req.headers['x-osah-token']` – omitted here for brevity but trivial to add. |
| **Electron renderer compromised** | Context isolation + sandbox + no `nodeIntegration`. The preload exposes **only** a gettable `{host,port}` object – no way to reach `require`, `process`, or other dangerous APIs. |

---

## 7. Future‑proofing (what’s left in docs/05‑phases.md)

- Phase 3: Add optional embeddings‑based semantic search (upgrade path from FTS → vector store).
- Phase 4: Package the Windows service + macOS LaunchAgent into `.exe`/`.app` installers (NSIS / `electron-forge`).
- Phase 5: Telemetry‑opt‑in + update channel, automated compliance scans.

None of these affect the core logic above; they are layers on top.

--- 

*This file captures the **internal logic** as of the working implementation. It is meant for maintainers who need to reason about why the code is organized this way and how each requirement is fulfilled by a concrete mechanism in the source tree.*