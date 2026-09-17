# 06 — Technical Documentation

Deep technical reference for implementers and reviewers. Complements the LLD
(what to build) with how pieces are built, tested, and secured.

---

## 1. Technology stack & justification

| Layer | Choice | Why |
|---|---|---|
| UI client shell | **Electron** | Desktop UX, tray, OS keychain access; thin client to the service |
| Backend / daemon | **Node + Express** (loopback) | Same language across UI; SSE; small footprint; runs headless as OS service |
| UI | **React 18 + Vite** | Fast HMR; matches user's existing stack |
| Validators | **Zod** (shared schemas) | One schema: server parse, client types |
| State (UI) | **zustand** | Small atom-friendly store |
| Persistence | **SQLite (`better-sqlite3`)** | Transactional (WAL) durability for chats/messages/settings/vault; single local file, no server |
| Keys/Sealing | Electron `safeStorage` / **keytar** + `node:crypto` AES-256-GCM | OS-grade custody; sealed settings (encrypt+HMAC) |
| HTTP client | native `fetch` | No SDK; OpenAI-compat by construction |
| Tests | **vitest** + **supertest** + **Playwright** | Unit/API/E2E |
| Packaging | **electron-builder** (NSIS Windows / dmg macOS) | Installers + OS service + LaunchAgent registration |
| Service wrappers | `node-windows`/`winsw` (WinService), LaunchAgent plist (macOS) | Always-on daemon (G9/FR-9) |

**No** external SaaS, **no** OpenAI SDK, **no** ORM server. Native module caveat:
`better-sqlite3` must be rebuilt for the Electron ABI (prebuilds in Phase 0).

---

## 2. Runtime environment & data locations

- Node 20+ (Electron bundles its own Node).
- App-data root: `app.getPath("userData")` / service data dir:
  - Windows: `C:\Users\<u>\AppData\Roaming\OpenSourceAPIHelper\` (service uses a
    dedicated service-account data dir when applicable, per ADR-010).
  - macOS: `~/Library/Application Support/OpenSourceAPIHelper/`
  - Linux: `~/.config/OpenSourceAPIHelper/`
- Files: `osah.sqlite` (settings-sealed row, vault, chats, messages, FTS, usage,
  audit), `snapshots/`, `logs/audit.log`. All gitignored.

---

## 3. Build & dev loop

```
npm install
npm run dev             # renderer (5174) + electron (spawns/attaches service)
npm run service:dev     # daemon only (loopback, dev token)
npm test                # vitest unit + supertest api
npm run e2e             # playwright electron (spawns real service)
npm run build           # lint + types + vite build + tsc
npm run package         # electron-builder (NSIS / dmg) + service install scripts
```

Three run modes:
- `desktop` — Electron UI + attached service (default).
- `serve --port 8787` — headless service (API + `/v1` proxy), for QA/CI.
- `browser` — React app served locally vs the daemon (dev/team).

---

## 4. Security model — full threat view

### 4.1 Assets
- **API keys** (highest value)
- **Master key** (OS keychain) and derived settings/vault subkeys
- **Sealed settings** (integrity)
- **Chat history / memory** (privacy)
- **Local bearer token** (loopback auth)

### 4.2 Threat agents
1. Casual local malware / shoulder-surfer reading files.
2. A buggy dependency inadvertently logging.
3. Network observer on loopback / proxy.
4. A malicious upstream endpoint (data-exfil attempt).
5. Repo contributor error (committing a real key).
6. **Non-interactive context:** the daemon runs as an OS service account —
   keychain access differs from the interactive user (ADR-010).

### 4.3 Mitigations mapped to NFRs

| Threat | Control | Where |
|---|---|---|
| At-rest file read | AES-256-GCM vault **+ sealed settings (encrypt+HMAC)**; master key in OS keychain; per-record nonce | `vault.ts`, `settings.ts` |
| Config file edit/view | **No raw-config file; no raw-config endpoint; typed DTOs only** through the service | `settings.ts`, API |
| Service-account keychain mismatch | ADR-010: dedicated service account or one-time passphrase derivation | `keychain.ts` |
| Log/key leak | `redact()` at logger/error boundary; masked views; CI grep hard-fail | `audit.ts`, `error.ts` |
| Proxy sniffing | loopback bind; optional local token (`timingSafeEqual`); TLS outbound | `proxy.ts`, `auth.ts` |
| Malicious upstream | validate base_url scheme/host; refuse non-TLS redirect; size caps | `validation.ts`, `openai.ts` |
| DB tamper/corruption | WAL + `PRAGMA quick_check`; sealed settings tag; snapshots/restore | `db.ts` |
| XSS / CSRF (browser) | React escaping; CSP; local token via header (not cookie) | renderer, server |
| Memory privacy | retrieval is local (FTS); embeddings opt-in + local option; preview before injection | `memory.ts` |
| Dependency supply-chain | lockfile, `npm audit` CI, minimal deps | CI |

### 4.4 Key lifecycle table (authoritative)

| Stage | Stored as | Readable by | UI shows |
|---|---|---|---|
| Incoming (paste) | memory only during POST | service crypto fn | `•••••` |
| At rest | ciphertext in `osah.sqlite` | — (only `vault.decrypt`) | masked `sk-…J333` |
| During Test / Chat / Proxy | in-memory per call, dropped after | validation/chat/proxy once | spinner / status / — |
| In logs/errors | **never** | — | — |
| In export | decrypted at user-invoked download | .env download | — |

---

## 5. Threat model — attack narratives (test them)

1. **"Grep the data dir" test.** Full add→test→chat→restart flow, then
   `grep -rn "sk-" data/ sqlite`. Nothing. (CI.)
2. **"No config file" test.** The app-data dir contains **no** readable config;
   settings row is opaque ciphertext; there is no raw-config endpoint in the
   OpenAPI spec.
3. **"Crash mid-write" test.** Kill the service mid-save → SQLite WAL keeps the
   old or new state; no torn/blinded row.
4. **"401 upstream" test.** Dead key → error body has no key; audit shows
   `Bearer …***`.
5. **"Tampered vault/settings" test.** Flip a byte → GCM/HMAC fails → "config
   sealed / restore snapshot", never a key.
6. **"HTTP downgrade" test.** Upstream redirect to `http://` → refused.
7. **"Slow reasoning model" test.** GLM full returns only `reasoning_content`
   for 100 s+ → validation soft-warns + suggests `-flash`; proxy respects client
   disconnect.
8. **"Service restart" test.** Service killed → supervisor restarts; UI
   reattaches; chats/messages/active intact.

---

## 6. Testing strategy

| Level | Tool | Scope |
|---|---|---|
| Unit | vitest | vault round-trip/tamper; seal/unseal; normalizeBase table; redact; export; provider-merge; registerModels; memory FTS scoring |
| API | supertest + temp sqlite | all routes (§3 LLD) with mocked `openai.ts`; 200/401/404/410/reasoning-only/SSE; multi-session concurrency; auth (missing/bad token) |
| Component | React testing library | settings tab, masked input, streaming chat, model picker, memory preview |
| E2E | Playwright + Electron | §7 (v2) items 1–12 incl. OS restart → service + chats intact |
| Security | manual + CI | the 8 narratives in §5 |

**Coverage gate:** vault, settings-seal, normalizeBase, redact, provider-merge,
registerModels, proxy-route, memory-retrieve ≥ 90% line; E2E blocks on golden path.

---

## 7. OWASP baseline (verify in Phase 4)

1. **A01 — Access control:** proxy `/v1/*` token when enabled; loopback scope.
2. **A02 — Crypto failures:** AES-256-GCM only; HKDF subkeys; no MD5/SHA1 for
   integrity (GCM tag + HMAC).
3. **A03 — Injection:** model from registered allowlist; never `eval`; FTS query
   escaped.
4. **A04 — Insecure design:** sealed settings + DTO-only API is the core design —
   "no config file" is enforced by schema + no-endpoint + CI grep, not convention.
5. **A05 — Misconfig:** CSP, no debug stack traces to renderer, `nosniff`.
6. **A06 — Vulnerable components:** `npm audit` CI; lockfile committed.
7. **A07 — Auth failures:** loopback token via `timingSafeEqual`.
8. **A08 — Integrity:** Zod schema validation; parse errors loud.
9. **A09 — Logging/monitoring:** redaction at the log-writer boundary; audit.
10. **A10 — SSRF:** base_url scheme/host whitelist; no internal-subnet bypass
    without explicit user-owned override.

---

## 8. Mapping to the studied reference (Hermes provider surface)

| Reference concept | This tool |
|---|---|
| `providers:` config | sealed settings `ProviderEntry[]` |
| env secret + `key_env:` | `vault` id via `keyRef` |
| `hermes model` picker | Settings tab + Chat model picker + Activate |
| custom-endpoints tab | Settings custom endpoint form (same fields) |
| Test button (`validateCustomEndpoint`) | `POST /api/providers/:id/test` (auto-registers models) |
| merge-on-edit (#69988) | `providers.ts#mergeEntry` |
| base_url normalize | `normalizeBase()` |
| `hermes proxy` | `proxy.ts /v1/*` (now always-on in service) |
| `hermes config check` | `config.ts#check` + Dashboard warnings |
| credential pool / fallback | Phase 3 key pools |
| **chat / memory (new)** | `chat.ts` + `memory.ts` (in the managed client, not an agent framework) |
| **OS service (new)** | WinService / LaunchAgent daemon |

---

## 9. Migration & evolution

- `schema_version` in SQLite + `SealedSettings.version`; ordered migrations at
  boot, before any write; re-seal after settings migration (atomic).
- Backward-compat: sealed settings version tolerant; older clients read DTO-only
  — never raw.
- The OpenAI `/v1` shape is the **stable external contract** — never break it
  across major versions.

---

## 10. Definition of "done" for this doc-set
- `01` PRD (FR/NFR, v2 acceptance gate §7).
- `02` HLD (two-process service+UI, flows, deployment).
- `03` LLD (schemas, API, validation/chat/memory/proxy/vault, installers).
- `04` Architecture (principles, diagrams, trust, rationales, ADR-001..012).
- `05` Phases (Phases 0–5, DoD, dependency, risk, order).
- this `06` (stack, security, threats, testing, evolution).

All traceable: FR/NFR id → component (HLD) → interface (LLD) → decision (ADR)
→ phase → security/test control (this doc).

