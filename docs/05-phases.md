# 05 — Delivery Phases (roadmap)

Sequenced increments; each is independently shippable with a **Definition of
Done** (DoD). Estimates are engineering-guesses for a single full-stack dev
(Ankur) — recalibrate as you go.

Legend: `[M]` must / `[S]` should / `[N]` nice-to-have.

---

## Phase 0 — Scaffold & tech probes  *(¼–½ week)*
**Goal:** prove the risky parts early; standing repo skeleton.

- npm workspaces: `renderer/` (Vite+React), `service/` (Express), `electron/`.
- **Secret probes:** Electron `safeStorage` on Windows; SQLite better-sqlite3
  rebuild under Electron; **Windows Service keychain bridge** (ADR-010) — probe
  DPAPI scope under a service account.
- Loopback Express boot + `/api/health`; loopback local bearer token handshake.
- CI skeleton: lint, vitest, Playwright smoke (Electron boots, hooks service).

**DoD:** app launches, renderer calls one real service method with the local
token, master key persists across restart, CI green.

---

## Phase 1 — Settings tab + keys + test-on-add  *(1½–2 weeks)*
**Goal:** the core loop — add key+URL, Test, models appear.

- Catalog (`catalog.ts`): OpenAI, Anthropic, Google/Gemini, DeepSeek, OpenRouter,
  xAI, z.ai/GLM, Cohere, Mistral, Groq, NVIDIA NIM, Ollama.
- Settings tab UI (FR-1): provider list, add custom endpoint, masked key input,
  **Test button**, status dot.
- Vault + sealed settings (`vault.ts`, `settings.ts`, `keychain.ts`).
- Providers CRUD with **merge** + **registerModels** (FR-3.3 → models visible).
- Validation (`validation.ts`): test + discovery + reasoning/EOL guards.
- Active default selection (FR-5).
- API: catalog, providers, keys, test, activate, models, status.
- Unit + API test coverage.

**DoD = §7 items 2–4** (settings tab; mask; Test populates model list; invalid
key → redaction clean).

---

## Phase 2 — Chat client (multi-session)  *(1–1½ weeks)*
**Goal:** chat with streaming, multiple concurrent sessions, per-chat model.

- Chat service (`chat.ts`): sessions + messages persistence (SQLite), SSE
  streaming, per-chat model override (FR-6.3).
- UI Chat page: session tabs (create/switch/rename/delete), composer, streaming
  render, model picker from `/api/models`, history/resume (FR-6.4).
- `POST /api/chats/:id/messages` stream + plain; usage rows.
- E2E: two chats stream concurrently; switching one to DeepSeek doesn't affect
  the other; resuming a session continues its history.

**DoD = §7 items 5–7** (open chat, stream, multi-session, per-chat model).

---

## Phase 3 — Memory + durability + hardening  *(1–2 weeks)*
**Goal:** "keeps chats and can take reference," restart-safe, production-grade.

- Memory/retrieval (`memory.ts`): FTS5 index on messages; `reference` API +
  transparent preview (FR-7.2/7.3); embeddings opt-in (ADR-011).
- Durability (G8): WAL, snapshots/restore, boot restore of settings+chats+active
  (FR-8). E2E: kill/restart → chats intact.
- Audit UI; usage/cost telemetry (opt-in); credential-pool rotation.
- OWASP + threat narratives (`06` §5, §7).

**DoD = §7 items 1, 8, 9, 11** (service returns on restart; memory reference
works; no key in logs).

---

## Phase 4 — OS service install + dual-platform  *(1–2 weeks)*
**Goal:** installed app + always-on service; Windows & macOS.

- **Service packaging:** `installers/` — Windows Service
  (`OpenSourceAPIHelperService`, auto-start, Node service `node service/index.js`);
  macOS LaunchAgent plist; uninstall cleanup (FR-9).
- **Service-account keychain bridge** finalized (ADR-010) + tested on both OSes.
- Tray: active-model badge, start/stop, open UI (FR-9.4).
- electron-builder NSIS installers for Windows + macOS (Code signing decision).
- Proxy (`proxy.ts`) always-on in the service (`/v1/models` + chat completions),
  plus ADR-007 auth decision.
- Full E2E + security checklist from a clean OS install.

**DoD = §7 items 1 (service), 10 (no config-edit surface), 12 (macOS flow).**

---

## Phase 5 — Polish & breadth  *(ongoing / best-effort)*
- `[S]` `/v1/responses` Responses API (ADR-008).
- `[S]` OAuth "Accounts" (Nous/Codex/Copilot) — ADR-009.
- `[S]` Embedding memory (v3) tuned per-provider; local embedder option.
- `[N]` Community provider packs (JSON catalog, validated on load).
- `[N]` Theme/locale polish (dark-glassmorphism consistent with user's app).
- `[N]` Settings-only cloud sync (never keys) — user-managed storage.

**DoD:** each slice lands independently behind its phase flag; no architectural
change required.

---

## Dependency graph

```
Phase0 ─► Phase1 ─► Phase2
            │         │
            └─────────┴──► Phase3 ─► Phase4 ─► Phase5 (optional slices)
```

- Phase 4 (service) could overlap Phase 2 (chat) once the vault/settings +
  proxy are stable; keep at least the Phase 3 durability work *before* the OS
  service becomes consumers' trust anchor.

---

## Risk register (top)

| Risk | Mitigation |
|---|---|
| Windows Service ↔ interactive-user DPAPI mismatch (ADR-010) | dedicated service account or one-time passphrase derivation; probe in Phase 0; tested in Phase 4. **Do not ship before resolved.** |
| better-sqlite3 native node under Electron packaging | prebuilds for Electron ABI in Phase 0; fallback `node:sqlite` if available |
| SSE streaming/teardown bugs in chat | Phase 2 dedicated time; supertest SSE fixtures; abort-on-close tests |
| Reasoning-only models (full GLM) appearing unusable | validation soft-warns + suggests `-flash` sibling |
| Secret leaking via local token or proxy | loopback bind + constant-time token check + redaction middleware + CI grep |
| Config-edit surface reappearing | sealed settings (no raw-config endpoint) + no file-open in code; enforced by review gate ADR-002/10 |
| Scope creep into "full Hermes clone" | non-goals §2.2; chat/memory stay *in the managed client*; PRs reviewed against invariants |
| Key/prompt data exfiltration by an upstream | validate base_url; never follow non-TLS redirect; memory is local/opt-in |

---

## Suggested execution order (day-blocks, MVP)

1. Phase 0: safeStorage + SQLite + **service-keychain probe**.
2. DB schema + sealed settings/unseal + config check.
3. Catalog + Providers CRUD (merge) + registerModels.
4. Vault encrypt/decrypt + masked views + local token.
5. Validation/test + discovery + reasoning/EOL guards.
6. Settings tab (keys + Test + model list). → **Phase 1 gate**
7. Chat service + multi-session UI + per-chat model. → **Phase 2 gate**
8. Memory FTS + reference + durability/snapshots. → **Phase 3 gate**
9. Windows Service + macOS LaunchAgent + tray + proxy-always-on. → **Phase 4 gate**
10. Security checklist + installers.

Tag each gate `vX.Y`; keep `docs/01-requirements.md` §7 as the living checklist.

