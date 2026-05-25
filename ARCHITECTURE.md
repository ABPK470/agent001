# Architecture

This repository is a TypeScript monorepo built around a functional-core /
imperative-shell doctrine.

## Package map

- `packages/agent`: execution core, loop, planner, governance, tools, model adapters
- `packages/server`: Fastify shell, SQLite persistence, auth, orchestration, SSE, routes
- `packages/sync`: extracted sync subsystem, including preview/execute, environments,
  recipes, diff engine, plan store, and sync tool factories
- `packages/shared-enums`, `packages/shared-types`: shared contracts
- `packages/ui`, `packages/ui-term`: user interfaces

## The load-bearing rule

> Shell owns state; core is stateless; dependencies are always parameters.

Consequences:

- boot-time state lives on explicit shell objects or on the frozen host
- per-operation data is passed through function parameters or closure capture
- no ambient runtime lookup is part of the intended architecture
- new configuration wiring uses `configure...` / `replace...` style APIs, not
  exported ambient setters

## System shape

```text
user / UI
  -> @mia/server
     -> @mia/agent
     -> @mia/sync
     -> SQLite / SSE / auth / external systems
```

`@mia/server` is the composition root. It builds the host once, wires concrete
adapters, and registers HTTP routes and orchestrators.

`@mia/agent` contains the reusable execution machinery.

`@mia/sync` is a sibling domain package, not an agent subfolder.

## Boot flow

1. Server loads config and database state.
2. Server builds `AgentHost` via `configureAgent(...)`.
3. Server wires sync infrastructure with:
   - `configurePlanStore(...)`
   - `configureSyncOrchestrator(...)`
   - `configureSyncEventSink(...)`
   - `configureSyncRunSink(...)`
4. Server constructs the run orchestrator and route handlers.
5. Per request or per run, the server passes the host into the relevant tool or orchestrator path.

## Sync architecture

The sync subsystem now lives in `packages/sync/src` and depends only on shared
contracts, `mssql`, and its local sync facade in `contracts.ts`.

Important properties:

- `@mia/sync` no longer depends on `@mia/agent`
- server code imports sync APIs from `@mia/sync`, not from `@mia/agent`
- SQL telemetry attribution is explicit: preview and execute construct a
  telemetry context object and pass it into diff-engine and execute helpers
- environment state, plan cache, recipe bundle cache, and event/run sinks all
  live on `host.sync`

## Lint-enforced boundaries

`scripts/lint-arch.mjs` enforces:

- agent cluster-door imports
- no module-level mutable state outside allowlists
- server must not import agent internals
- server sync imports must come from `@mia/sync`
- doctrine rules for ALS, exported `setXxx`, and banned port suffixes

The doctrine enforcement now scans `packages/sync/src` as well as the agent and
server code paths.

## Where state lives

State is expected in only a few places:

- Fastify/server objects
- SQLite and other adapter instances
- `AgentHost`
- explicit caches attached to the host, such as `host.sync.plans` and
  `host.sync.recipes`
- per-run or per-call local variables and closures

State is not expected to hide behind ambient runtime lookups.

## Current caveat

`lint-arch` still reports an existing 60-violation baseline, mostly from older
agent cluster-door imports and legacy module-level mutable state. Phase 8 did
not erase that backlog; it promoted the doctrine rules and ensured the sync
package itself does not add new ambient-state violations.

## Reading order

If you need the shortest useful orientation path:

1. `docs/doctrine.md`
2. `docs/P&A_refactor.md`
3. `packages/agent/src/lib/index.ts`
4. `packages/server/src/index.ts`
5. `packages/sync/src/index.ts`
