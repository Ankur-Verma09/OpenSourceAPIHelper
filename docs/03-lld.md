# 03 — Low-Level Design (LLD)

Bottom-up detail for implementers. Complements `02-hld.md`. Every section is
independently implementable.

Target stack (ADR-1, `04-architecture.md`): Electron (UI client) + Node/Express
(service/daemon) + SQLite, React (Vite).

---

## 1. Repository layout

```
OpenSourceAPIHelper/
├─ package.json                 # workspaces
├─ service/                     # the daemon (Windows Service / LaunchAgent / serve)
│  ├─ index.ts                  # boot: open DB, unseal settings, listen loopback
│  ├─ supervisor.ts             # daemon lifecycle, service bindings, health
│  ├─ auth.ts                   # local bearer token issue/verify (timingSafeEqual)
│  ├─ settings.ts               # sealed settings: seal/unseal/migrate/check (DTO)
│  ├─ vault.ts                  # AES-256-GCM encrypt/decrypt/purge/scan
│  ├─ keychain.ts               # safeStorage/keytar adapter (win/mac/linux) + service-account bridge
│  ├─ db.ts                     # SQLite (better-sqlite3): schema, WAL, migrations
│  ├─ catalog.ts                # known-provider table
│  ├─ providers.ts              # provider CRUD (merge), model registration
│  ├─ validation.ts             # test + discovery + reasoning/EOL guards
│  ├─ chat.ts                   # sessions + streaming, per-chat model
│  ├─ memory.ts                 # FTS retrieval (v2) / embeddings (v3)
│  ├─ proxy.ts                  # OpenAI /v1 server (SSE + plain)
│  ├─ export.ts                 # .env / json / openrouter
│  ├─ status.ts                 # dashboard aggregate
│  ├─ audit.ts                  # rotating redacted logger
│  ├─ error.ts                  # ApiError, redact helpers
│  └─ openai.ts                 # minimal OpenAI-compatible client (fetch)
├─ renderer/                    # React (Vite) UI client
│  ├─ src/
│  │  ├─ pages/{Dashboard,Settings,Endpoints,Chat,History}.tsx
│  │  ├─ chat/                  # multi-session store, SSE hook, composer, model picker
│  │  ├─ api/client.ts          # authed fetcher (local token)
│  │  └─ store/                 # zustand atoms: active, keys, sessions, status
├─ electron/                    # thin shell → talks to service
│  ├─ main.ts                   # window, tray, spawn/attach service
│  ├─ preload.ts                # window.osah (narrow bridge)
│  └─ service-probe.ts          # health check + (re)spawn/attach
├─ installers/                  # WinService registration (node-windows/winsw), LaunchAgent plist
├─ shared/
│  └─ types.ts                  # Zod schemas (single source)
├─ data/                        # app-data (gitignored): osah.sqlite, snapshots/, logs/
├─ test/                        # vitest, supertest, Playwright (electron)
└─ docs/
```

---

## 2. Data model (Zod schemas — `shared/types.ts`)

### 2.1 Catalog provider
```ts
CatalogProvider = {
  id: string; name: string; docs_url?: string;
  base_url: string;             // default
  key_env: string;              // convention only
  default_model?: string;
  transport: "openai";
  supports: { models: boolean; stream: boolean; discover: boolean };
}
```

### 2.2 Provider entry (from sealed settings; NO secrets)
```ts
ProviderEntry = {
  id: string; kind: "catalog" | "custom";
  name: string; base_url: string;        // normalized
  model?: string;                        // default model for this provider
  keyRef?: string;                       // → vault.id
  keyEnv?: string;                       // export alias
  discover_models?: boolean;
  context_length?: number;
  models?: Record<string, ModelMeta>;    // { [modelId]: { context_length?; status? } }
  extra_headers?: Record<string,string>; // preserved on merge
  active?: boolean;
  order?: number;
  createdAt: string; updatedAt: string;
}
```
**Model registration** (FR-3.3): on successful Test, `discovered[]` are merged
into `models`; the selectable list (**Chat + Settings**) reads union of
`models` keys across providers → the source of truth for the model picker
(FR-5, FR-6.3).

### 2.3 Vault record
```ts
VaultRecord = {
  id: string; providerRef: string;
  ciphertext: string; iv: string; tag: string;   // AES-256-GCM
  label?: string;
  createdAt: string; updatedAt: string;
  lastTest?: TestResult;
}
```

### 2.4 Test result
```ts
TestResult = {
  ok: boolean; statusCode?: number;
  error?: string;               // redacted
  modelEol?: boolean;           // 410
  reasoningOnly?: boolean;      // content:null + reasoning_content
  latencyMs?: number;
  discovered?: string[];        // auto-registered by providers.ts on ok
  testedAt: string;
}
```

### 2.5 Sealed settings (FR-10 / G10)
```ts
SealedSettings = {
  blob: string;        // base64(AES-256-GCM( JSON{SettingsDoc} , settingsKey ))
  tag: string;         // base64(HMAC-SHA256(blob))            // integrity
  version: number;
}
SettingsDoc = {
  schemaVersion: number;
  active: { providerId: string; model: string } | null;
  proxy: { enabled: boolean; port: number; token?: string };  // token random at install
  prefs: { theme: "dark" | "system" | "light"; useHistory: boolean };
  providers: ProviderEntry[];                                 // sealed inside here
}
```
- settingsKey = HKDF(master_key, "osah:settings"); vaultKey = HKDF(master_key, "osah:vault").
- The daemon unseals **in memory only**; no raw-config endpoint (only typed DTOs).

### 2.6 Chat session + message
```ts
ChatSession = {
  id: string; title: string;
  modelOverride?: { providerId: string; model: string } | null;  // FR-6.3
  pinned?: boolean; archived?: boolean;
  createdAt: string; updatedAt: string;
}
ChatMessage = {
  id: string; sessionId: string; role: "user" | "assistant";
  content: string;                 // plaintext local
  model?: string; tokens?: number; ts: string;
}
ReferenceScope = {                 // FR-7.2 / 7.3
  mode: "recent" | "all" | "sessions";   sessionIds?: string[];
  limit: number;                       // top-k snippets
  embed?: boolean;                     // v3 embeddings retrieval
}
```

---

## 3. Service API contract

All requests require `Authorization: Bearer <local-token>` (except `/health` and
`/v1/*` which route to proxy, auth per ADR-007).

### 3.1 Settings / providers / models
| Method | Path | Body → success |
|---|---|---|
| GET | `/api/health` | → `{ ok, version, db:"ok" }` (no auth) |
| GET | `/api/catalog` | static cache |
| GET | `/api/providers` | → `{ providers: ProviderEntryView[], active }` (view + hasKey,maskedKey,status) |
| POST | `/api/providers` | `{ kind:"custom", name, base_url, model?, api_key?, discover_models?, context_length? }` → `201 view` |
| PUT | `/api/providers/:id` | partial (merge; `api_key:undefined`=no-change, `""`=purge) → `200 view` |
| DELETE | `/api/providers/:id` | `?purgeKey=true` also deletes vault row → `204` |
| POST | `/api/providers/:id/keys` | `{ api_key, label? }` → `201 {hasKey:true}` |
| POST | `/api/providers/:id/test` | `{ model? }` → `200 TestResult` (auto-registers models) |
| PATCH | `/api/providers/:id/activate` | `{ model }` → `200 active` |
| GET | `/api/models` | → `{ models: [{providerId,name,base_url,status}] }` (selectable list) |

### 3.2 Chats / messages / memory
| Method | Path | Body → success |
|---|---|---|
| GET | `/api/chats` | list (incl. archived) |
| POST | `/api/chats` | `{ title?, modelOverride? }` → `201 ChatSession` |
| GET | `/api/chats/:id` | session + messages (paged) |
| PATCH | `/api/chats/:id` | `{ title?, modelOverride?, pinned?, archived? }` → `200` |
| DELETE | `/api/chats/:id` | → `204` (cascade messages) |
| POST | `/api/chats/:id/messages` | `{ content, stream?:boolean, reference?:ReferenceScope, temperature? }` → SSE (`text/event-stream`) or `200 ChatMessage` |
| POST | `/api/chats/:id/reference` | `{ prompt, scope }` → `{ snippets:[{sessionId,text,score,ts}] }` (not a completion; caller builds prompt) |

### 3.3 Status / export
| Method | Path | Notes |
|---|---|---|
| GET | `/api/status` | providers+keys+models+service uptime; cheap |
| POST | `/api/export` | `{ format:"env"|"json"|"openrouter", providers? }` → attachment/safePreview |

### 3.4 Proxy (`/v1/*`) — external contract
- `GET /v1/models` → OpenAI list from active provider's models.
- `POST /v1/chat/completions` → forward; SSE + plain; active-provider routing.
- `POST /v1/responses` → **Phase 3** gate.

---

## 4. Validation flow (`validation.ts`)

```
validate(entry, key, model?)
 1. url = normalizeBase(entry.base_url)
 2. if count(providers.models) is 0 or model or discover:
      GET {url}/models
        | 200 -> ids[] (cache)
        | 401 -> fail{auth} (redacted)
        | 404 -> fall to 1-token chat (no /models route)
        | 410 -> modelEol=true; return
 3. if needs 1-token chat: POST {url}/chat/completions
        {model: model||entry.model||ids[0], messages:[{role:user,content:"ping"}], max_tokens:1, stream:false}
 4. classify: ok=true; discovered=ids; latencyMs; reasoningOnly = content===null && reasoning_content
 5. persist TestResult; if ok → providers.ts#registerModels(entry.id, ids)   // FR-3.3
```

### Model auto-registration (the "as soon as connection established, model added
and visible" requirement — G3 / FR-3.3)
```
registerModels(id, ids[]): for each id -> entry.models[id] ??= {}
   bump updatedAt; re-seal settings; notify /api/models listeners.
```

### Base-URL normalization (fixes the live NVIDIA bug we hit)
```ts
function normalizeBase(raw: string): string {
  const u = new URL(raw);
  if (!["http:","https:"].includes(u.protocol)) throw ApiError.invalid("scheme");
  let p = u.pathname.replace(/\/+$/,"");
  if (p === "/v1") { /* ok */ }
  else if (p.endsWith("/chat/completions")) p = p.slice(0, -"/chat/completions".length) || "/v1";
  if (p && !p.startsWith("/v1")) p = p + "/v1";
  return `${u.origin}${p}`;
}
```

### Reasoning-only + EOL guards
- `reasoningOnly` → soft warning, suggest `-flash` sibling on discovery list.
- `modelEol` (410) → friendly "pick another" hint.

---

## 5. Vault (`vault.ts`) + keychain (`keychain.ts`)

```
master = keychain.get("osah-master")            // 32B, os-random at first run
settingsKey = HKDF(master, "osah:settings")
vaultKey    = HKDF(master, "osah:vault")
encrypt(providerRef, pt, label?) ->
  iv=randomBytes(12); ct=AES-GCM(pt, vaultKey, iv); return VaultRecord
decrypt(r) -> string (in-memory only)
seal(doc: SettingsDoc)  -> SealedSettings(blob=AES-GCM(json(doc), settingsKey), tag=HMAC)
unseal(sealed)          -> SettingsDoc | throws(on tag mismatch)
```

**Service-account bridge (FR-9 + Open Q1):** The daemon may run as a non-
interactive account (Windows Service). Options in preference order:
1. **Dedicated service account** whose DPAPI/Keychain the daemon uses; the UI gets
   exchange-only access via a service API + local token (no key cross-over).
2. If the service must use `LocalSystem`, DPAPI scope ≠ user scope → one-time
   setup: prompt a passphrase once, derive master key via Argon2, store only an
   encrypted-wrapping blob (never the phrase).
3. Fallback: master under the **interactive user** keychain, UI unlocks the
   service per boot (degrades always-on G9 — last resort).
Record the chosen approach in ADR-010. **Do not ship until #1 or #2 is
implemented and tested on Windows + macOS.**

**Atomicity:** SQLite WAL transactions; no separate `.json.tmp` rename needed
(DB does it). Snapshots to `snapshots/` for restore.

---

## 6. Chat service (`chat.ts`) — multi-session + streaming

```
POST /api/chats/:id/messages {content, stream:true}
 1. resolve model: session.modelOverride ?? settings.active            // FR-6.3
 2. build context: [system persona + injected memory (FR-7) if reference.scope] + history
 3. persist user msg (tx)
 4. if reference.scope: snippets = memory.retrieve(scope); prepend as context
 5. call openai.chat(provider, key, model, {stream})
 6A. stream: pipe chunks to client; on 'done' persist assistant msg + usage (tx)
 6B. plain: await full; persist; return
Concurrency: sessions are independent records; two chats stream simultaneously
because each is its own HTTP handler + DB tx (better-sqlite3 serializes writes).
```

---

## 7. Memory / retrieval (`memory.ts`)

- **Index:** on assistant-message persist, write `messages_fts` (FTS5) columns:
  `content`, `sessionId`, `ts`, `role`, `tokens`.
- **v2 retrieval (default):** `memory.retrieve({query, sessions?, limit=8})` uses
  FTS5 `MATCH` (BM25) over `content`, ranked by relevance + recency.
- **v3 retrieval (opt-in, Phase 3+):** embeddings via a selected embedding-
  capable provider from the managed list (or a local model). Store
  `message_embeddings` rows; cosine top-k. Privacy: embeddings stay local unless
  a cloud embeddings provider is explicitly chosen.
- **Injection contract:** retrieved snippets form a read-only
  `system:{source_history}` block; not writable by the model.
- **Explicit scoping (FR-7.2):** `POST /api/chats/:id/reference` returns snippets
  the UI shows before sending — the user sees what memory will be used.

---

## 8. Proxy (`proxy.ts`)

```
handleChat(req):
  cfg = unseal(settings)
  p   = providerById(cfg.active.providerId)     // or per-request provider if provided
  k   = vault.decrypt(p.keyRef)
  up  = {p.base_url}/chat/completions
  if req.body.stream:
    ac = new AbortController() ; req.on("close", () => ac.abort())
    upRes = await fetch(up, {...headers:{Authorization:`Bearer ${k}`}, body, signal:ac.signal})
    res.writeHead(upRes.status, {"content-type":"text/event-stream", "cache-control":"no-cache"})
    for await (chunk of upRes.body) res.write(chunk); res.end()
  else:
    r = await fetch(up, {...}); res.status(r.status).json(await r.json())
  record usage(row)                              // Phase 3 cost
```
- Proxy auth: if `cfg.proxy.token` set → require `Authorization: Bearer <token>`
  on `/v1/*`, compared `timingSafeEqual` (ADR-007).
- Bind: `127.0.0.1` only.

---

## 9. UI (renderer) — pages & state

| Page | Renders | State atoms (zustand) |
|---|---|---|
| Dashboard | status cards, active badge, service uptime | `active`, `statuses`, `svc` |
| Settings | catalog + custom endpoints + keys (masked) + Test buttons | `providers`, `keys` |
| Endpoints | custom endpoint CRUD + discovered model list | `endpoints`, `models` |
| Chat | multi-session tabs, composer, SSE stream, per-chat model picker, history/ref panel | `sessions`, `activeSession`, `stream` |
| History/Reference | past chats, attach-as-context, retrieve preview | `memSnips` |

Preload bridge:
```ts
window.osah = {
  health(), listProviders(), addProvider(), testProvider(id), setKey(id, key),
  activate(id, model), listModels(),
  listChats(), createChat(), getChat(id), updateChat(id, patch), deleteChat(id),
  sendMessage(id, {content, stream, reference}) → (stream via SSE),
  listStatus(), export(format)
}
```
Renderer never receives/parses raw keys. Streaming is surfaced via the service
SSE endpoint.

---

## 10. Error taxonomy (`error.ts`)

```
ApiErrorCode = "invalid"|"not_found"|"auth"|"upstream"|"config"|"vault_locked"|
               "unsupported"|"service"
ApiError { code, message (redacted), status, detail? }
redact(text): /sk-[A-Za-z0-9_-]{6,}/, /Bearer\s+\S+/ → "…***"
```
Middleware: unknown route → 404; 500 → generic body; detail only in audit,
redacted.

---

## 11. Auth for the service loopback (`auth.ts`)

- On first install, generate `localToken = randomBytes(32).toString("base64url")`;
  store sealed with settings (not exposed raw after install).
- UI bridge holds the token in the OS keychain (Electron `safeStorage`); sends
  `Authorization: Bearer <token>`.
- Every request except `/health` verifies token (constant-time). `/v1/*` uses
  ADR-007 (same token or open-loopback).
- Browser flavor: token via same-origin cookie/header set by the shell; CSRF-safe.

---

## 12. Test contract

**Unit (vitest):** `vault` round-trip + tamper; `seal/unseal`; `normalizeBase`
table; `redact`; `export.*`; provider-merge; `registerModels`; memory FTS scoring.

**API (supertest + in-mem sqlite / temp data dir):** all routes in §3 with mocked
`openai.ts`; fixtures 200/401/404/410/reasoning-only/SSE; multi-session
concurrency; auth rejections (missing/bad token).

**E2E (Playwright + Electron):** full acceptance flow `01-requirements.md` §7
(v2 items 1–12), including restart → service returns + chats intact.

**Security manual:** grep app-data after full flow → no plaintext key; grep audit
after forced 401 → no key; confirm settings blob is opaque; confirm no raw-config
endpoint in the OpenAPI spec.

---

## 13. Installers / service packaging

- **Windows:** electron-builder NSIS → after install run `service install`
  (node-windows/winsw) creating `OpenSourceAPIHelperService`, auto-start,
  loopback listener; UI added to shell (tray). Uninstall removes service + stops
  daemon.
- **macOS:** ship `com.opensourceapihelper.plist` (LaunchAgent, `RunAtLoad`,
  `KeepAlive`) → `launchctl load` on postinstall; unload on uninstall.
- Daemon runs `node service/index.js` from installed resources with its own
  rotating log under app-data.

---

## 14. Migration / schema versioning

- `db.ts#migrate` runs at boot: applies ordered migrations on `schema_version`.
- `SealedSettings.version` separate from DB version; unseal → if older schema,
  migrate SettingsDoc then re-seal (atomic).
- Backups: on major version bump take a sealed snapshot in `snapshots/`; restore
  path restores DB + re-sealed settings from snapshot.

