# `@mia/server`

Fastify HTTP server that hosts agent runs, persists state, and streams
events to the UI.

## Responsibilities

- REST API for runs, agents, layouts, memory, notifications.
- SSE event stream (`/api/events/stream`) — the single realtime channel.
- Run orchestration for start / stop / resume / fail-over agent runs.
- Persistence — SQLite over better-sqlite3 (see `platform/persistence/`).
- Static file serving for the built UI in production.
- Catalog cache, attachment service, sandbox file isolation.

## Layout

| Folder / file           | Purpose                                                                                 |
| ----------------------- | --------------------------------------------------------------------------------------- |
| `index.ts`              | Entry point — wires Fastify, plugins, feature routes, and runtime services.             |
| `bootstrap/`            | Composition helpers for config, workspace, LLM, and sync bootstrapping.                 |
| `features/`             | HTTP routes plus feature-local orchestration for runs, auth, sync, layouts, and more.   |
| `platform/`             | Infrastructure: persistence, events, queueing, LLM, sandbox, effects, and MSSQL setup. |
| `shared/`               | Shared enums, HTTP helpers, utility code, and server-local types/errors.                |
| `ports/`                | Cross-package interfaces and contracts exposed by the server package.                    |
| `cli/`                  | Package-local scripts such as entity-registry export.                                   |
| `crypto/`               | Local cryptographic helpers.                                                            |

## Conventions

- **Imports inside the package**: import from the canonical top-level structure
  (`bootstrap/`, `features/`, `platform/`, `shared/`, `ports/`) and do not
  re-introduce compatibility mirror trees.
- **`platform/persistence/index.ts` is the persistence barrel**.
  Outside callers go through it; do not bypass it with ad hoc deep imports.
- **Wire enums**: own them in `@mia/shared-enums`. Re-export through
  `shared/enums/index.ts`. Do not re-declare.
- **Effects**: any code that writes to disk on behalf of a run **must**
  route through `platform/effects/` so the trajectory can be replayed / rolled back.
