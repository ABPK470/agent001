# `@mia/server`

Fastify HTTP server that hosts agent runs, persists state, and streams
events to the UI.

## Responsibilities

- REST API for runs, agents, layouts, memory, notifications.
- SSE event stream (`/api/events/stream`) — the single realtime channel.
- Application shell/core orchestration for start / stop / resume / fail-over agent runs.
- Persistence — SQLite over better-sqlite3 (see `adapters/persistence/`).
- Static file serving for the built UI in production.
- Catalog cache, attachment service, sandbox file isolation.

## Layout

| Folder / file           | Purpose                                                                                 |
| ----------------------- | --------------------------------------------------------------------------------------- |
| `index.ts`              | Entry point — wires Fastify, plugins, API routers, and application services.            |
| `api/`                  | Real transport edge: one module per HTTP/SSE resource.                                  |
| `auth/`                 | Authentication and session implementation.                                              |
| `browser/`              | Browser credential, context, handoff, policy, and guard implementation.                 |
| `application/shell/`    | Stateful runtime orchestration, queueing, proposer scheduling, and workspace execution. |
| `application/core/`     | Stateless coordination and prompt/data-block logic.                                     |
| `adapters/persistence/` | SQLite-backed persistence for runs, memory, evidence, attachments, and tool cache.      |
| `adapters/effects/`     | Effect log — every filesystem mutation goes through here.                               |
| `adapters/llm/`         | LLM adapter door plus completion adapter bindings.                                      |
| `adapters/sync/`        | Server-local sync glue such as entity YAML/bootstrap helpers.                           |
| `llm/`                  | LLM provider/runtime implementation.                                                    |
| `sandbox/`              | Per-run filesystem/process sandboxing implementation.                                   |
| `enums/`                | Façade re-exports of `@mia/shared-enums` plus server-private enums.                     |
| `tools.ts`              | Server-owned tool registry and per-run tool composition.                                |

## Conventions

- **Imports inside the package**: prefer the cluster's `index.ts`
  (`from "./api/index.js"`, `from "./adapters/persistence/index.js"`, etc.)
  and import canonical implementation folders directly (`auth/`, `browser/`,
  `llm/`, `sandbox/`) instead of re-introducing mirror shim trees.
- **`adapters/persistence/index.ts` is the documented persistence barrel**.
  Outside callers go through it; do not bypass it with deleted legacy paths.
- **Wire enums**: own them in `@mia/shared-enums`. Re-export through
  `enums/index.ts`. Do not re-declare.
- **Effects**: any code that writes to disk on behalf of a run **must**
  route through `adapters/effects/` so the trajectory can be replayed / rolled back.
