# 02 — High-Level Design (HLD)

Builds on `01-requirements.md`. States how the system is split, how the parts
talk, and the key data flows. Detailed interfaces live in `03-lld.md`,
technology/rationale in `04-architecture.md` and `06-tech-doc.md`.

---

## 1. System Context

The app is now a **two-process product**: a long-running **service (daemon)** and
a **UI client**. This is required by G9 (Windows Service / macOS LaunchAgent),
G8 (durability), and G10 (sealed config — the service is the only thing that can
decrypt/unseal state).

```
                      user (human)
                          |
                   +------v-------+
                   |   UI client   |   Electron (or browser) — React/Vite
                   |  (presenter)  |   connects to the service
                   +------+-------+
                          |  loopback HTTP + local bearer token
                          v
        +-----------------------------------------------------+
        |               Service (daemon)                       |
        |   Windows Service / macOS LaunchAgent /  `serve`     |
        |                                                        |
        |   catalog · settings/unsealer · vault · validation     |
        |   chat service · memory/retrieval · proxy (OpenAI /v1) |
        |   export · status · audit                               |
        +-------+-----------------------------+-----------------+
                |             |                |
        +-------+-----+ +-----v-----+   +-----v------------------+
        | OS keychain  | |  SQLite   |   |  External LLM providers |
        | (master key) | | chats+mem |   | OpenAI·DeepSeek·NVIDIA  |
        |              | | settings  |   | NIM·OpenRouter·Anthropic|
        |              | | vault     |   | ·custom endpoints       |
        +---------------+ +-----------+   +------------------------+
                                                        ^
                        external tools (Cursor, test     |
                          suites, aider) -- POST /v1 ---+  (proxy → active key)
```

**Scope boundary (why this is not Hermes):** still **no** autonomous agent
tool-loop, no skill/memory-agent as a product surface, no messaging gateway, no
multi-user backend. The new chat + memory live *inside the managed client*, not a
general-purpose agent framework.

---

## 2. Logical Components

| # | Component | Responsibility | Key inputs | Outputs/Effects |
|---|---|---|---|---|
| C1 | **UI client (renderer)** | Settings/keys mgmt, chat (multi-session), model picker, dashboard | User actions, service JSON, SSE | Commands to service |
| C2 | **Service API (Express)** | Loopback HTTP/api, local-token auth, route dispatch | inbound JSON | responses/SSE |
| C3 | **Settings/unsealer** | Read/decrypt sealed settings, catalog lookup, normalize, merge writes, migrate, config-check | sealed blob | in-memory config |
| C4 | **Credential vault** | Encrypt/decrypt/store keys; mask; never plaintext on read | raw key / record id | ciphertext; masked view |
| C5 | **Validation service** | Test (auth+connectivity), discover models, latency/status, reasoning/EOL guards | provider cfg + vault id | TestResult |
| C6 | **Chat service** | Sessions (multiple), streaming, per-chat model, persistence | message, session id, model | SSE response + stored msgs |
| C7 | **Memory/retrieval** | Index past messages; full-text (v2) / embedding (v3) search; inject context | query + scope | context snippets |
| C8 | **Proxy (`/v1`)** | OpenAI-compatible routes to active provider; stream; cancel on client-close | OpenAI request | upstream call / SSE |
| C9 | **Export service** | Build `.env` / JSON / OpenRouter exports | user trigger | file/string |
| C10 | **Status service** | Aggregate key-endpoint-chat health | vault+settings+lastTest | dashboard DTO |
| C11 | **Audit service** | Rotating, redacted event log | internal events | `audit.log` |
| C12 | **Persistence (SQLite + files)** | Transactional store: settings, vault, chats, messages, FTS index, usage | reads/writes | durable rows + snapshot backups |
| C13 | **Service supervisor** | Daemon lifecycle, install/register OS service, tray bridge, auto-restart | OS events | service up/down, loopback port |

---

## 3. Persistent Store (sqlite + sealed settings)

Everything lives in one transactional SQLite DB under the OS app-data dir, plus
a sealed settings blob. This replaces the v1 "two JSON files" model to satisfy
durability (G8), multi-chat (G6/FR-6), memory (FR-7), and sealing (G10).

| Table / blob | Contents | Encrypted? |
|---|---|---|
| `settings` (sealed row) | providers[], active, schema_version, proxy cfg, prefs — **no secrets**, sealed (encrypt + HMAC) | sealed by OS-keychain-derived key |
| `vault` | provider_ref, ciphertext(AES-256-GCM), nonce, tag, label, meta | yes |
| `chat_sessions` | id, title, created/updated, pinned, model_override, archived | no (not secret; chat contents are user data but local) |
| `messages` | session_id, role, content_txt, tokens, ts, usage | no |
| `messages_fts` | FTS5 index over messages for retrieval | n/a (derived) |
| `usage` | provider, model, tokens_in/out, latency_ms, cost?, ts | no |
| `audit` | ts, event, redacted_detail | no |
| `snapshots/` (dir) | sealed backups for restore | yes |

- **Master key:** 32 bytes from OS keychain (Windows DPAPI/CNG, macOS Keychain,
  Linux libsecret). Used to (a) derive the settings-sealing key and (b) key the
  vault ciphertext records. Never stored in the repo or as plaintext.
- **Sealing** (“masted” config, G10/FR-10): the settings blob is
  `JSON → AES-256-GCM` under the settings key, plus an HMAC-SHA-256 tag. There is
  **no readable config file** and the API exposes **no** raw-config endpoint —
  only typed DTOs (providers, active, etc.). This kills the "open the config file"
   threat outright.
- **Failure mode:** keychain unavailable or tag mismatch → “config sealed /
  vault locked” gate; no plaintext fallback (NFR-1, NFR-7).

---

## 4. Core Data Flows

### 4.1 Add key → Test-on-add → models appear (the heart of the UX)
```
UI (Settings) paste key + url
  -> POST /api/providers/:id/keys         (C4 encrypt → vault row)
  -> status = unverified
UI clicks Test (same form)                [G3 / FR-3]
  -> POST /api/providers/:id/test
  -> C5 decrypt credential, build OpenAI client
  -> GET {base}/models                     (fallback chat 1-token on 404)
  -> record {ok|error, latencyMs, models[]}
  -> C5 writes models[] into provider entry (auto-register)
  -> UI + Chat model selector now list them                    [FR-3.3]
```

### 4.2 Multi-session chat (streaming, per-chat model)
```
UI Chat: create session A -> POST /api/chats
UI Chat: pick model (default = active; override per chat)      [FR-6.3]
UI Chat: send msg A1 -> POST /api/chats/:id/messages {stream:true}
  -> C6 persists user msg, resolves {provider,key,model}
  -> C6 calls upstream chat/completions with SSE
  -> C6 streams SSE deltas -> UI renders
  -> C6 persists assistant msg + usage
second chat B created while A streams; both independent        [FR-6.2]
```

### 4.3 Memory / take-reference
```
UI Chat: "summarize what I concluded about proxy routing"
  -> user toggles "use history" or explicit "attach chat X"
  -> C7 retrieves top-k snippets (FTS v2 / embeddings v3) from past sessions
  -> C7 injects as system/context block into the prompt sent by C6
  -> model answers grounded in past chats                       [FR-7.2]
```

### 4.4 Proxy (consume the keys from other tools)
```
any OpenAI client -> POST http://127.0.0.1:8787/v1/chat/completions
  -> C8 reads active provider/model, C4 decrypts key
  -> forwards to upstream, streams back (SSE or plain)
  -> records usage (Phase 3)
```

### 4.5 Durability + restart (G8, FR-8)
- Every message/settings write is a single SQLite transaction (WAL) → atomic,
  crash-safe; chats & history unaffected across kill/restart.
- On daemon boot: open DB, unseal settings, load vault, restore active model,
  reattach chat sessions in UI.

---

## 5. Service / daemon operation (FR-9, G9)

- **Windows:** installer creates a Service (`OpenSourceAPIHelperService`,
  LocalSystem or a dedicated low-priv account, auto-start). UI never owns the
  data path — it talks to the service over loopback HTTP with a local bearer
  token.
- **macOS:** a `LaunchAgent` plist (`~/Library/LaunchAgents/…plist`) runs the
  daemon headless; UI connects over loopback.
- **UI launch:** Electron checks health endpoint; if the daemon is absent it
  spawns the daemon (or asks the user to start the service) and reconnects.
- **Tray:** start/stop, show proxy port/channel, active-model badge.

The daemon is the **only** process allowed to touch the keychain, unseal
settings, and write the DB — single-writer, single-owner.

---

## 6. API surface (high level)

| Method & path | Purpose |
|---|---|
| `GET /api/catalog` | Known-provider catalog |
| `GET /api/providers` | Configured providers/endpoints (typed DTO; no raw config) |
| `POST|PUT|DELETE /api/providers[/:id]` | Provider/endpoint CRUD (merge on edit) |
| `POST /api/providers/:id/keys` | Add/rotate key |
| `POST /api/providers/:id/test` | Test + discover models (auto-registers) |
| `PATCH /api/providers/:id/activate` | Set active default model |
| `GET /api/chats` · `POST /api/chats` | List / create sessions |
| `GET /api/chats/:id` · `PATCH` · `DELETE` | Session read/rename/archive/delete |
| `POST /api/chats/:id/messages` | Send (stream or plain); optional retrieval scope |
| `POST /api/chats/:id/reference` | Attach a past chat / retrieve snippets as context |
| `GET /api/models` | Flat selectable model list (from validated providers) |
| `GET /api/status` · `POST /api/export` | Dashboard · export |
| `GET /v1/models` · `POST /v1/chat/completions` | Proxy (external consumers) |

Full schemas in `03-lld.md`.

---

## 7. Deployment topologies

1. **Service + Electron UI** (primary, target — Windows & macOS).
2. **Headless daemon** (`OpenSourceAPIHelper serve --port 8787`) — proxy + API
   only, for CI/QA test suites pointing at a stable loopback URL.
3. **Browser UI** — same React app served locally, talking to the daemon with a
   local token (dev/team convenience).

---

## 8. Error handling & resilience

- SQLite WAL → no torn writes; `busy_timeout`; corruption → snapshot restore.
- Upstream timeouts (test 30 s; proxy configurable) — a hung upstream never hangs
  the proxy or a chat session (abort on client-close).
- Upstream 401 → 502 with redacted detail; audit redacted.
- Model EOL (410) → `modelEol:true` + "pick another" hint.
- Reasoning-only responses → soft warning (GLM lesson) + suggest `-flash`.
- Service restart on crash (supervisor); DB foreign-key/schema migration at boot.

---

## 9. Security posture (builds on NFR-1..4; full model in `06`)

1. **At rest:** SQLite + AES-256-GCM vault; settings sealed; key in OS keychain.
2. **In transit:** loopback daemon requires local bearer token (CSRF-safe);
   outbound TLS.
3. **Config file:** **sealed / not user-editable / no raw-config endpoint** (G10).
4. **Logs:** redacted; audit available.
5. **UI:** masked inputs; CSP; strict CORS to localhost; never receives keys.
6. **Least privilege:** daemon is single file/keychain owner; loopback bind only.

---

## 10. Key design invariants (carry into LLD)

1. Service is the **single owner** of data, keychain, sealing, and DB (G9).
2. Settings/vault are **encrypted / sealed**; no plaintext config on disk.
3. No API returns raw secrets or raw config — typed DTOs only (G10).
4. Keys masked in UI; redacted in logs/errors (G10, NFR-2).
5. Provider edits **merge** (never clobber unknown fields) — Hermes #69988 lesson.
6. Base URL normalized (scheme+host, `/v1`-coerced, baked-in `/chat/completions`
   fixed).
7. Validation is test-on-add → **auto model discovery/registration** (G3).
8. Chats are transactional and durable; multi-session concurrent (G6, G8).
9. Memory is retrieval-in-time with explicit opt-in/local scope (G7, FR-7.4).
10. The OpenAI `/v1` shape is the stable external contract (never break it).