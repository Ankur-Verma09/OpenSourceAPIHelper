# OpenSourceAPIHelper — Requirements Document (PRD)

**Product:** Managed **LLM key manager + chat client** with memory and an OS-level service.
**Folder:** `E:\E\Git\OpenSourceAPIHelper`
**Version:** 2.0 (expanded scope)
**Status:** Proposal
**Author:** Ankur (Lead SDET) + AIWithAnkur

> Evolution from v1: the tool grew from a pure "API key manager" into a
> **managed chat client + credential/chat service** — you add keys, pick models,
> chat across multiple sessions, keep history with context memory, and the whole
> thing runs as a background OS service that survives restart. It is **still not**
> Hermes: no autonomous agent tool-loop, no skills/memory-agent, no messaging
> gateway, no session store shipped as a standalone product.

---

## 1. Problem Statement

Using LLM API keys today means you juggle keys, base URLs, model names, and chat
sessions across many tools, with no safe visual model. Requests from v1:

1. Keys live as plaintext in `.env` / config and get leaked or committed.
2. There's no single UI to add, test, and select providers/models.
3. Chat threads, prompts, and "what worked before" are not kept in one place.
4. Restarting the machine means re-configuring / losing session state.
5. Nothing runs as a first-class background service on Windows/macOS.

**Outcome:** one local app that (a) stores and tests keys behind a redacted UI,
(b) discovers models automatically, (c) lets you start multiple chats and pick any
added model, (d) persists chats and lets you reference past ones, (e) keeps
everything through restarts, and (f) installs as a background OS service on
Windows and macOS. Other tools can also consume the same keys via an
OpenAI-compatible proxy.

---

## 2. Goals / Non-Goals

### 2.1 Goals
- **G1 — Secure key store.** Keys encrypted at rest (AES-256-GCM), master key in
  the OS keychain, masked in the UI, never logged.
- **G2 — Provider catalog + custom endpoints.** Known providers (OpenAI, Anthropic,
  Google/Gemini, DeepSeek, OpenRouter, xAI, z.ai/GLM, Cohere, Mistral, Groq,
  NVIDIA NIM, Ollama, …) plus arbitrary **custom** OpenAI-compatible endpoints.
- **G3 — Test-on-add.** Enter key + URL → **Test** → on success the endpoint's
  models are discovered, added to the model list, and selectable immediately.
- **G4 — Settings tab.** One **Settings** page where the user adds/manages all keys
  and endpoints (no file editing anywhere).
- **G5 — Active selection.** A persisted active provider + model; per-chat model
  override allowed (see G6).
- **G6 — Chat client, multi-session.** A chat box supporting **multiple concurrent
  chats** (tabs/sessions), streaming, and per-chat model selection from the
  discovered list.
- **G7 — Memory.** Persistent chat history survives restart; the user can **take
  reference** from any past chat (attach it as context / auto-retrieve relevant
  snippets). Survives app shutdown and OS restart (G9).
- **G8 — Data durability.** No data loss on restart, crash, or kill: atomic writes,
  transactional store.
- **G9 — Always-on service.** Installed as a **Windows Service** (and **macOS
  LaunchAgent**) so the app and its API/proxy run in the background independent of
  the UI window.
- **G10 — Redaction & tamper-resistance.** Keys are never visible; the config is
  **not accessible/editable as a file** — it is sealed (encrypted + integrity-checked)
  and only the service can read it in memory.
- **G11 — Cross-platform.** Windows (primary) and macOS both supported.

### 2.2 Non-Goals (explicitly out of scope — still not "full Hermes")
- **NG1** — No autonomous agent loop / arbitrary tool-calling from chat.
- **NG2** — No generic skills / memory-training / agentic task execution.
- **NG3** — No messaging gateway (Telegram, Discord, SMS, Email).
- **NG4** — No multi-user cloud backend (single-user, local-first).
- **NG5** — No OAuth "Accounts" flows in v2 (deferred; key-centric).
- **NG6** — No distributed/HA scale; a handful of providers / hundreds of messages is the ceiling.
- **NG7** — No user-facing config-edit surface of any kind (by design, G10).

---

## 3. Personas & Usage Scenario

| Persona | Description | Top need |
|---|---|---|
| **Solo dev / ML engineer** | Runs several tools needing LLM keys + wants a work chat | One validated source of truth, chat + history |
| **QA automation engineer** (Ankur) | Points test suites at a stable OpenAI-compatible endpoint | Local proxy with a stable, key-free URL |
| **Power user** | Keeps many chats on many models | Multi-session chat with memory + model switching |

**Scenario (primary):**
Ankur installs the app. It registers a background **service**. He opens Settings,
pastes a DeepSeek key and an NVIDIA NIM GLM key (both masked), clicks **Test** on
the NIM one: the app calls `GET /v1/models`, discovers `deepseek-ai/*` and
`z-ai/glm-*`, and the active model list fills in. He opens Chat, starts three
tabs: "GLM flash", "DeepSeek", "Test notes". In a new tab he asks "summarize what
I concluded about proxy routing last week" and the app retrieves past snippets
(memory) into context. He restarts the machine — service comes back, all four
chats and settings are intact. He points his test suite at
`http://127.0.0.1:8787/v1`; it routes through the selected key. Nothing was
ever shown in plaintext, no config file was ever opened.

---

## 4. Functional Requirements

IDs trace through HLD/LLD/phases. Settings = keys + endpoints + global prefs.

### FR-1 Provider catalog + Settings tab
- FR-1.1 `.Settings` tab lists catalog providers (data-driven table: `id`, `name`,
  docs URL, default base URL, env-var convention, default model hint).
- FR-1.2 Add a **custom endpoint** in Settings: `name`, `base_url`, `model`,
  optional `context_length`, `discover_models` toggle, key.
- FR-1.3 Keys are added/edited/rotated/removed entirely inside Settings — no file
  editing surface exists.

### FR-2 Credential management
- FR-2.1 Add key per provider (masked input).
- FR-2.2 Edit/rotate; **blank clears** the key.
- FR-2.3 Remove key (confirm dialog).
- FR-2.4 Multiple keys per provider allowed (pool; rotation in Phase 3).
- FR-2.5 API never returns plaintext; UI reads `is_set`, masked prefix, metadata.

### FR-3 Test-on-add → auto model discovery (the core loop)
- FR-3.1 In Settings, as soon as the user enters a **key + URL** there is a
  **Test** button.
- FR-3.2 Test performs auth + connectivity check: `GET /models` (fallback: 1-token
  chat completion when `/models` 404s).
- FR-3.3 On success, discovered model ids are stored AND **immediately visible in
  the model-select list** in Settings and Chat.
- FR-3.4 Per-key `status`, `last_verified_at`, redacted `error`; editing a key
  resets status to `unverified`.
- FR-3.5 Reasoning-only responses (`content:null` + `reasoning_content`) are a
  **soft warning**, not a failure (GLM full model lesson); suggests a `-flash`
  sibling when present.
- FR-3.6 EOL/410 (model "gone") is surfaced with a friendly "pick another" hint.

### FR-4 Custom endpoints — validation & merge
- FR-4.1 `base_url` must have scheme+host; normalized (trailing slash, coerced to
  `/v1` root, baked-in `/chat/completions` fixed).
- FR-4.2 Editing a custom endpoint **merges** (preserves `extra_headers` etc.).

### FR-5 Active provider/model selection
- FR-5.1 One persisted active provider+model; UI badge shows it.
- FR-5.2 Per-chat model override allowed (FR-6.2). Proxy uses the active default.

### FR-6 Chat client (multi-session)
- FR-6.1 Chat box with streaming output over SSE.
- FR-6.2 **Multiple concurrent chats** — the user can create/switch/rename/delete
  several chat sessions at once; each is independent.
- FR-6.3 **Per-chat model selection** from the discovered model list (FR-3.3); the
  active default is pre-selected.
- FR-6.4 Each chat has a persistent session id; resuming continues it.

### FR-7 Memory & cross-chat reference
- FR-7.1 All chats and messages persist to a transactional store (survives
  restart/crash — G8).
- FR-7.2 **Take reference:** from a chat, user can attach any prior chat (or ask to
  "summarize/use last week's chats") — the service injects relevant past snippets
  as context into the prompt.
- FR-7.3 Optional automatic retrieval (v2 = full-text/FTS; v3 = embedding-based)
  of past snippets when the user opts in on a message.
- FR-7.4 Memory is local; nothing leaves the machine except the final LLM call.

### FR-8 Durability & life-cycle
- FR-8.1 Atomic, crash-safe writes (WAL/transactional store + `rename` files).
- FR-8.2 On boot the service restores: settings, keys (from vault), active model,
  all chat sessions, their scroll/message state.
- FR-8.3 Schema versioning + migration; snapshot backups; corruption → restore.

### FR-9 Service (Windows + macOS)
- FR-9.1 Installer registers a **Windows Service** (`OpenSourceAPIHelperService`)
  and a **macOS LaunchAgent** plist.
- FR-9.2 The service runs headless in the background: hosts the Chat API, the
  OpenAI-compatible proxy, the vault, and the memory store — independent of the
  UI window.
- FR-9.3 The UI (Electron) is a *client* to the service over loopback; on launch it
  connects/reattaches (spawns the service if not running).
- FR-9.4 Service auto-starts; restart survives; manual start/stop from a tray menu.
- FR-9.5 Proxy binds `127.0.0.1`; optional local bearer token (ADR-007).

### FR-10 Redaction & config masking
- FR-10.1 Keys masked everywhere in UI (`sk-…xYz4`); inputs are masked.
- FR-10.2 **Config is sealed:** settings + endpoints are stored encrypted with an
  integrity tag; there is **no plaintext config file** and **no file-edit/view
  surface** in the app. Only the service reads config in memory.
- FR-10.3 Logs/errors are redacted (secrets never written).

### FR-11 Audit (light)
- FR-11.1 Redacted activity log (add/rotate/remove/export/activate/config) — no secrets.

---

## 5. Non-Functional Requirements

| ID | Area | Requirement |
|---|---|---|
| NFR-1 | Security | Keys at rest AES-256-GCM; master key in OS keychain (DPAPI/Keychain/libsecret); no plaintext anywhere. |
| NFR-2 | Security | Redaction at the log/error boundary (`sk-…`); no secrets in resp bodies. |
| NFR-3 | Security | Loopback-only proxy; optional local token (`timingSafeEqual`); TLS outbound. |
| NFR-4 | Security | XSS/CSRF hardened renderer; CSP; strict CORS to localhost; validate base_url (SSRF). |
| NFR-5 | Platform | Windows (primary) + macOS; service (`WinService`/`LaunchAgent`); keychain per platform. |
| NFR-6 | Performance | UI list ops < 200 ms; proxy overhead < 50 ms; chat first-token fast; test timeout 30 s. |
| NFR-7 | Reliability | Transactional persistence; no data loss on crash/kill; corruption detection + restore. |
| NFR-8 | Observability | Structured JSON logs; redacted; audit available. |
| NFR-9 | Usability | Add key → Test → model appears → chat: under 2 minutes for first-time user. |
| NFR-10 | Data | Single-user, local-first; no telemetry by default; opt-in only. |
| NFR-11 | Scale | Tens of endpoints, hundreds of chats, thousands of messages — local SQLite is ample. |

---

## 6. Regulatory / Policy / Ethical Notes

- **Key custody / chat privacy:** everything is local to the user's machine; only
  prompts sent to an actively-selected LLM provider leave the machine. Memory stays
  on-device.
- **Explicit consumption:** using a key (chat, proxy, export) is always an explicit
  user action; nothing auto-exfiltrates.
- **No circumvention feature:** legitimate credential management only; no bypass or
  abuse tooling (consistent with the standing boundary in this project).
- **Open Source:** MIT; dependency licenses compatible.

---

## 7. Acceptance Criteria (MVP gate — v2)

From a clean Windows install:

1. Installer registers the Windows Service; it auto-starts; UI connects to it.
   — *FR-9*
2. Settings tab lists catalog + custom endpoints; pasting a key masks it; no
   plaintext key is found by grep in the app-data dir. — *FR-1, FR-10, NFR-1*
3. Enter NVIDIA NIM URL + GLM key → **Test** → valid; model list populates with
   `deepseek-ai/*`, `z-ai/glm-*`; models appear in Chat's selector. — *FR-3*
4. Add an invalid key → Test shows a red, redacted, actionable error. — *FR-3.4*
5. Open Chat, pick GLM flash, send a message; response streams. — *FR-6.1, .3*
6. Create a second chat while the first streams; both run concurrently; each
   remembers its own history. — *FR-6.2*
7. Switch one chat to DeepSeek; other chats unaffected. — *FR-6.3*
8. Restart the machine; service returns; both chats, settings, and active model
   are intact. — *FR-8, FR-9*
9. "Reference last week's chats" injects past snippets and the model answers
   using them. — *FR-7.2*
10. No path in the app lets the user open/view a config file; config is sealed.
    — *FR-10.2*
11. No API key string appears in any log line generated during the whole test.
    — *NFR-2*
12. The same flow passes on macOS (LaunchAgent instead of WinService). — *NFR-5*

---

## 8. Open Questions (for design review)

1. **Service keychain under OS accounts.** On Windows a service runs as `LocalSystem`
   (or a dedicated account); DPAPI scope differs from the interactive user. How do we
   give the service and the UI the *same* master key safely? (Options: dedicated
   service account + DPAPI; a one-time setup passphrase to derive the master key;
   keychain per-account with a bridge.) **Blocking for FR-9 + NFR-1.**
2. **Proxy auth default.** Loopback-open vs required bearer token (ADR-007) — revisit
   once the service becomes a long-running daemon.
3. **Memory retrieval method.** v2 FTS full-text vs v3 embeddings (which embeddings
   model? local vs a managed key). Cost/privacy trade-off.
4. **"Reference" UX.** Auto-injection toggle vs explicit "attach chat/summarize past"
   command — decide the least-surprising default for QA-style users.
5. **Multi-user.** A single service can't easily separate two Windows accounts —
   accept single-user for v2.

---

*Next documents:* `02-hld.md`, `03-lld.md`, `04-architecture.md`,
`05-phases.md`, `06-tech-doc.md`. Index in `README.md`.