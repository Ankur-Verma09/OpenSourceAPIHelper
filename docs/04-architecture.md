# 04 — Architecture (decisions, diagrams, ADRs)

Architectural intent + decision record. Complements HLD (structure) and LLD
(interfaces). Read this to know **why** the shape is what it is.

---

## 1. Architectural principles

1. **Local-first, secret-custodian.** A local credential + chat service. No
   cloud, no telemetry by default.
2. **Service is the single owner.** Data, keychain, sealing, DB, proxy — one
   long-running daemon owns all of it (Windows Service / macOS LaunchAgent).
3. **UI is a thin client.** Electron connects over loopback; it never owns a
   credential or the DB.
4. **Secrets and settings are different kinds of truth, and both are protected.**
   Keys in a ciphertext vault; settings **sealed** (encrypted + HMAC). No
   plaintext config exists on disk, and there is no file-edit surface.
5. **Everything the UI writes, tools can consume.** Chat uses managed keys; the
   OpenAI `/v1` proxy exposes them to any client.
6. **Validation is a product feature.** Test-on-add auto-registers models — the
   moment a connection succeeds the models are selectable.
7. **Merge, don't clobber config.** Provider config larger than the form must
   survive an edit.
8. **Memory is local and explicit.** Retrieval reports what will be used before
   it is injected.
9. **Redact at the boundary.** Keys are radioactive: masked in UI, stripped from
   logs, never in error bodies.

---

## 2. Component diagram (C4 L2)

```
┌─────────────┐   loopback HTTP + local bearer token
│  Electron   │ ◄────────────────────────────┐
│  UI client  │                              │
└─────────────┘                              │
   │                                          v
   │  window.osah (contextBridge / fetch)   ┌────────────────────────────────┐
   │                                        │      Service (daemon)           │
   │                                        │  Windows Service / LaunchAgent  │
   │                                        │  (Express + SQLite)             │
   │                                        │                                  │
   │                                        │  catalog · settings/unseal       │
   │                                        │  vault · validation · chat       │
   │                                        │  memory · proxy(/v1) · export    │
   │                                        │  status · audit · supervisor     │
   │                                        └─────┬─────────────┬─────────────┘
   │                                              │             │ loopback /v1
   │                                        ┌─────┴────┐   ┌────▼──────────────┐
   │                                        │ OS key   │   │ external tools    │
   │                                        │ chain    │   │ (Cursor, test     │
   │                                        │ (master  │   │  suites, aider)   │
   │                                        │  key)    │   │   ── POST /v1 ──► │
   │                                        └──────────┘   └──────────────────┘
   │
   ▼
┌──────────────────────────────────────────────┐
│  app-data/osah.sqlite (WAL)                  │
│   settings (sealed row) · vault · chats      │
│   messages · messages_fts · usage · audit    │
│  snapshots/ (backups) · logs/                │
└──────────────────────────────────────────────┘
          │ outbound HTTPS 443
          ▼
   ┌──────────────────────────┐
   │ LLM providers             │
   │ OpenAI · DeepSeek · NVIDIA│
   │ NIM · OpenRouter · custom │
   └──────────────────────────┘
```

---

## 3. Sequence — "add key, test-on-add, model appears, chat with memory"

```
User   UI client   Service     Vault  Validation  Memory   Upstream   Chat
 │key+url │  /keys  │                           │                    │
 │───────►│────────►│ encrypt ──► (row)          │                    │
 │ Test   │ /test   │          │                │                    │
 │───────►│────────►│ decrypt                        GET /models      │
 │        │         │────────►│───────────────►│───────────►         │
 │        │         │◄── TestResult + discovered  ◄──────────────────│
 │        │         │── registerModels(id, ids)  → models list       │
 │        │◄── models now visible in Settings & Chat picker          │
 │ chat   │ /messages (stream)                    │                    │
 │───────►│────────►│  resolve {provider,key,model}      superset     │
 │        │         │  if reference.scope: retrieve(scope)            │
 │        │         │  inject snippets as system context              │
 │        │         │────────── POST chat/completions (SSE) ────────►│
 │        │◄─ SSE deltas ────────────────────────────────────────────│
 │        │◄─ assist msg persisted + usage row ──────────────────────│
```

---

## 4. Data / trust boundaries

| Boundary | Allowed | Forbidden |
|---|---|---|
| UI client ↔ service | typed DTOs, SSE, masked views, TestResults | raw keys in response bodies; raw-config endpoint |
| Service ↔ OS keychain | read/write master key | store plaintext keys outside vault |
| Service ↔ upstream | HTTPS 443 with bearer auth | downgrade, insecure redirects |
| Service ↔ external tools (`/v1`) | OpenAI-compatible JSON/SSE on loopback (w/ token) | broad-cast bind, plaintext keys in responses |
| Service ↔ disk | sealed settings, ciphertext, SQLite WAL, redacted logs | plaintext keys/config anywhere |

---

## 5. Design rationales

| Decision | Rationale / what we avoided |
|---|---|
| Two-process (service + UI) | Required by G9 (OS service), G8 (durability), G10 (seal, only daemon decrypts). UI can die; daemon and data persist. |
| SQLite WAL single-owner | Transactional durability for chats/messages; no torn writes; single-writer avoids concurrency bugs across many sessions. |
| Sealed settings (no config file/endpoint) | Direct answer to "user must not open/edit config." A plaintext or even JSON config file is a file-edit surface; sealing + DTO-only API removes it. |
| Ciphertext vault + HKDF subkeys | Keys never plaintext; settings and key material use distinct derived keys; per-record nonce ⇒ tamper detection. |
| Test-on-add auto-registers models | Requirement #6 verbatim: the connection check is the onboarding step; discovery feeds the model picker. |
| Merging provider edits | Hermes #69988 lesson: clobbering drops `extra_headers`/`key_env`/`models`. |
| Base-URL normalize | Real endpoints ship `/v1/chat/completions` baked in (NVIDIA). One normalizer fixes the family. |
| Per-chat model override + global active | Requirement #5 (select models) + #4 (multiple chats); chat.runtime picks override ?? active. |
| Memory as retrieval, scoped + transparent | Requirement #3 (keep & reference chats). FTS v2, embeddings v3; always show what will be injected. |
| Stationary local token on loopback | Replaces HTTP-keychain-per-call; needed because a Windows Service can't be interactive. |
| No agent loop / gateway / skills | Still not Hermes. Chat + memory are *within* the managed client, not a general agent framework. |

---

## 6. ADR log

| ADR | Status | Decision | Supersedes |
|---|---|---|---|
| ADR-001 | Accepted | Electron (UI) + Node/Express (service) + React/Vite + SQLite; npm workspaces. Matches user stack (Interview app). | — |
| ADR-002 | Accepted | Keys in an AES-256-GCM vault keyed by OS keychain; **settings also sealed** (encrypt + HMAC). No plaintext on disk. | v1 plaintext `.env`/JSON settings |
| ADR-003 | Accepted | OpenAI-compatible proxy + config export are external consumption surfaces; **chat client is the in-app surface**. | v1 "no chat" |
| ADR-004 | Accepted | Provider edits **merge** (preserve unknown fields). | replace-in-place |
| ADR-005 | Accepted | Base-URL normalizer (baked-in `/chat/completions` fixed, `/v1`-coerced). | naive trim |
| ADR-006 | Accepted | Global active provider+model + **per-chat model override**; proxy uses active default. | single global only |
| ADR-007 | Open | Proxy `/v1/*` auth: open-loopback vs required local bearer token. Revisit now that daemon is always-on. | — |
| ADR-008 | Deferred | `/v1/responses` (Responses API) support — Phase 3. | — |
| ADR-009 | Deferred | OAuth "Accounts" (Nous/Codex/Copilot) — future phase; v2 is key-centric. | — |
| ADR-010 | Open | **Service-account keychain bridge** for Windows Service / macOS LaunchAgent master key (dedicated account vs one-time passphrase). Blocking for G9/NFR-1. | — |
| ADR-011 | Accepted | Memory = FTS5 full-text retrieval (v2) with opt-in embedding retrieval (v3). Local by default; retrieval is transparent (preview before injection). | v1 "no memory" |
| ADR-012 | Accepted | Multiple concurrent chat sessions in SQLite; per-session model override; SSE streaming. | single-thread UI |

---

## 7. Config health / self-check (analog of `hermes config check`)

On boot and on demand:
- sealed settings unseal (tag verifies) → else "config sealed / locked".
- schemaVersion migrated; unknown/missing keys warned.
- every `ProviderEntry.keyRef` resolves to a vault row.
- `active` provider still exists; else clear active + warn.
- `base_url` normalizes; flagged if it contains a credential-like substring.
- duplicate provider ids rejected.
- vault integrity: GCM tag verifies on decrypt; corrupt → snapshot-restore.
- DB integrity: `PRAGMA quick_check`; FTS rebuild available.

Output `{ ok, warnings[], lastChecked }` → surfaced in Dashboard.

---

## 8. Secrets in this repo (anti-pattern guard)

Docs carry **template** values only. No real key ever appears in docs/; fixtures
use `sk-test-…`. CI greps docs + source for `/sk-[A-Za-z0-9]/{12,}/` and fails
the build. The data dir is gitignored.

