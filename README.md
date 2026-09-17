# OpenSourceAPIHelper

A local-first, installable **LLM key manager + chat client with memory and an
OS service**. Add provider keys in a UI, test them (models appear
automatically), run multiple chats across any discovered model, keep history you
can reference later — all behind a redacted UI with **sealed config**, running as
a background **Windows Service / macOS LaunchAgent** that survives restart.

A deliberately slim re-implementation of the provider/credential + chat surface
of tools like Hermes Agent — **not** a full agent (no tool-loop, no skills, no
messaging gateway).

## Capabilities

- **Settings tab** — add/manage keys + endpoints for 35+ providers plus any
  custom OpenAI-compatible endpoint. **(Req 1)**
- **Test-on-add** — enter key + URL → **Test** → on success the models are
  discovered and become selectable immediately. **(Req 6)**
- **Chat client** — streaming chat, **multiple concurrent chats**, per-chat
  model picker drawn from the validated list. **(Req 2, 4, 5)**
- **Memory** — chats persist and you can take reference from past chats
  (FTS now, embeddings opt-in later). **(Req 3)**
- **Durability** — transactional SQLite store; nothing lost on restart/crash. **(Req 7)**
- **Redaction + sealed config** — keys never visible; the config file is
  encrypted/sealed and there is no file-edit or file-view surface. **(Req 8, 9)**
- **Always-on service** — installed as a Windows Service / macOS LaunchAgent that
  keeps the app + API + proxy running in the background. **(Req 10)**
- **Cross-platform** — Windows (primary) and macOS. **(Req 11)**
- **Consume anywhere** — OpenAI-compatible `/v1` proxy exposes the active key to
  any client (QA test suites get a stable, key-free loopback URL).

## Documentation (v2)

| Doc | What it contains |
|---|---|
| [`docs/01-requirements.md`](docs/01-requirements.md) | **PRD** — problem, goals/non-goals, FR/NFR, v2 MVP acceptance gate (12 items) |
| [`docs/02-hld.md`](docs/02-hld.md) | **HLD** — two-process (service + UI) context, components, data flows, service operation |
| [`docs/03-lld.md`](docs/03-lld.md) | **LLD** — repo layout, Zod schemas, full API contract, validation/chat/memory/proxy/vault detail, installers |
| [`docs/04-architecture.md`](docs/04-architecture.md) | **Architecture** — diagrams, trust boundaries, rationales, ADR-001..012 |
| [`docs/05-phases.md`](docs/05-phases.md) | **Phases** — Phases 0–5 with DoD, dependency graph, risk register, execution order |
| [`docs/06-tech-doc.md`](docs/06-tech-doc.md) | **Tech doc** — stack, threat model (8 narratives), OWASP baseline, test strategy, evolution |

All FR/NFR ids trace across the set: feature → component → interface → ADR →
phase → security/test control.

## Status

Docs v2 (design) **and** a working implementation both exist. The server
(Express + `node:sqlite` + AES-GCM vault + `/v1` proxy), React client, and
Electron wrapper are built and verified against a live provider stream. See
[`USAGE.md`](USAGE.md) for install / run / OS-service steps, or
[`docs/05-phases.md`](docs/05-phases.md) for what remains (Phase 4 packaging /
installers).

