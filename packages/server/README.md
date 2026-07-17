# `@mia/server`

Fastify HTTP server that hosts agent runs, persists state, and streams
events to the UI. Composition root of the monorepo shell.

## Responsibilities

- REST API for runs, agents, layouts, memory, notifications, sync, …
- SSE event stream (`/api/events/stream`) — the single realtime channel
- Run orchestration (start / stop / resume / fail-over)
- Persistence — SQLite (`infra/persistence/`)
- Static UI serving in production
- Wiring of `@mia/agent` / `@mia/sync` ports via `adapters/`

## Layout

| Folder | Purpose |
| ------ | ------- |
| `boot/` | Process spine — `start-server.ts`, context, LLM/catalog wiring |
| `http/` | Fastify composition — `build-app.ts` |
| `infra/` | Long-lived I/O — persistence, events, queue, sandbox, effects, MSSQL |
| `adapters/` | Concrete `@mia/agent` / `@mia/sync` port implementations |
| `api/` | Product HTTP surfaces (`runs`, `sync`, `platform`, `auth`, …) |
| `ports/` | Server-owned contracts (`*Sink` / `*Store` / `*Reader` / `*Client`) |
| `internal/` | Server-only helpers and enum façades |
| `cli/` | Setup wizard, export tools, db-status |

## Conventions

- Import from these top-level folders only. Old names (`bootstrap/`,
  `api/`, `platform/`, `shared/`, `app/`) are forbidden — enforced by
  `npm run lint:arch`.
- `infra/persistence/index.ts` is the persistence barrel for outside callers.
- Wire enums live in `@mia/shared-enums`; re-export via `internal/enums/`.
- Disk writes on behalf of a run go through `infra/effects/`.
- Operator control plane = `api/platform/` (not `api/deploy/`).
- Run prompt / tool-gating pure logic = `api/runs/prompting/`.
- Inside `api/<surface>/` use `service/` · `types/` · `state/` · `handlers/` —
  never Nest names (`application/`, `domain/`, `runtime/`, `transport/`).

See `docs/doctrine.md` for the full shell-layer rules.
