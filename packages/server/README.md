# `@mia/server`

Fastify HTTP server that hosts agent runs, persists state, and streams
events to the UI.

## Responsibilities

- REST API for runs, agents, layouts, memory, notifications.
- SSE event stream (`/api/events/stream`) — the single realtime channel.
- Orchestrator — start / stop / resume / fail-over agent runs.
- Persistence — SQLite over better-sqlite3 (see `db/`).
- Static file serving for the built UI in production.
- Catalog cache, attachment service, sandbox file isolation.

## Layout

| Folder / file | Purpose |
| --- | --- |
| `index.ts` | Entry point — wires Fastify, plugins, routes, orchestrator. |
| `routes/` | One file per resource (`runs`, `agents`, `memory`, etc.). Aggregated via `routes/index.ts`. |
| `orchestrator/` | Agent run lifecycle (start, stop, resume, recovery). |
| `db/` | Persistence — SQLite schema, migrations, repository functions. Curated barrel: `db/index.ts`. |
| `effects/` | Effect log — every filesystem mutation goes through here. |
| `memory/` | Episodic + semantic memory storage and retrieval. |
| `sandbox/` | Per-run filesystem sandbox. |
| `trajectory/` | Run trace persistence (steps, tool calls, planner decisions). |
| `enums/` | Façade re-exports of `@mia/shared-enums` plus server-private enums. |
| `tools.ts` | Tool registry adapted for `@mia/agent` consumption. |

## Conventions

- **Imports inside the package**: prefer the cluster's `index.ts`
  (`from "./memory/index.js"`, not the bare folder). Root-level shims
  (`memory.ts`, `effects.ts`, `db.ts`, `routes.ts`, etc.) were removed;
  do not re-introduce.
- **`db/index.ts` is the documented barrel** for the `db/` cluster.
  Outside callers go through it; do not bypass it.
- **Wire enums**: own them in `@mia/shared-enums`. Re-export through
  `enums/index.ts`. Do not re-declare.
- **Effects**: any code that writes to disk on behalf of a run **must**
  route through `effects/` so the trajectory can be replayed / rolled back.
