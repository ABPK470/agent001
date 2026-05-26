# Agent System

This document describes the current public shape of `@mia/agent` after the
zero-ambient-state refactor and the `@mia/sync` extraction.

## What `@mia/agent` owns

`@mia/agent` is the execution core:

- the agent loop
- planner, recovery, delegation, and governance logic
- tool contracts and most tool implementations
- the frozen boot host created by `configureAgent(...)`

It does **not** own server runtime state, request-local ambient context, or the
sync subsystem implementation anymore.

## The rule

The package follows one doctrine:

> Shell owns state; core is stateless; dependencies are always parameters.

In practice that means:

- no ambient runtime lookups
- no exported module-level `setXxx(...)` mutators for boot wiring
- no new `AsyncLocalStorage` for passing hidden dependencies
- long-lived state belongs on `AgentHost` or on explicit shell objects

## Boot shape

The server constructs one host at boot:

```ts
const host = configureAgent({
  mssqlDatabases,
  mssqlDefaultConnection,
  catalogInstances,
  catalogDefaultCachePath,
  browserContextReader,
  browserCredentialReader,
  browserHandoffStore,
  attachmentStore,
  shellClient,
  browserClient,
})
```

That host is then threaded into the orchestrator, tool factories, and other
boot-time wiring. Dependencies are visible at the call site instead of being
looked up ambiently later.

## Package boundaries

The system-level split is now:

- `@mia/server` is the shell: Fastify, SQLite, SSE, auth, channels, scheduling
- `@mia/agent` is the core orchestration package
- `@mia/sync` is a sibling package for sync preview/execute, environments,
  recipes, plan storage, and sync tools

`@mia/agent` re-exports the sync public surface from `@mia/sync`, but the sync
implementation no longer lives under the agent package boundary.

## Main clusters in `src/`

### `agent/`, `loop/`

Own the think → act → observe loop. These modules orchestrate one run and call
the tool layer, planner, and governance helpers.

### `context/`

Token budgeting, truncation, and compaction. This is where long transcripts are
made small enough for the model.

### `planner/`

Structured execution pipeline for complex goals: generate, parse, validate,
execute, verify, and repair.

### `recovery/`

Failure detectors, hints, retries, and loop-stuck mitigation.

### `delegation/`

Sub-agent spawning, delegation validation, and escalation.

### `governance/` and `domain/`

Run policy, audit/event semantics, quality checks, and the core domain types
used across the execution loop.

### `tools/`

Most tool implementations still live here. Tools are built with explicit host
dependencies rather than ambient setters.

### `llm/`

Model adapters implementing the `LLMClient` contract.

## Public API

The main public barrel is `src/lib/index.ts`.

Key exports:

- `configureAgent`
- `Agent`
- tool and model contracts from `types.ts`
- curated cluster barrels
- sync re-exports from `@mia/sync`

Consumers should import from `@mia/agent`, not from deep source paths.

## What changed in the refactor

The old ambient runtime pattern is gone from the active path:

- sync moved out to `@mia/sync`
- sync SQL telemetry now uses an explicit context object instead of ALS
- server sync wiring now uses `configureSyncEventSink`, `configureSyncRunSink`,
  and `replaceEnvironments`
- the doctrine lint in `scripts/lint-arch.mjs` now treats doctrine violations
  as errors for new code paths and scans `packages/sync/src` too

## Reading order

If you are new to the package, read in this order:

1. `docs/doctrine.md`
2. `src/lib/index.ts`
3. `src/application/shell/agent.ts` and `src/application/shell/agent-cluster/`
4. `src/application/shell/loop.ts` and `src/application/shell/loop-cluster/`
5. `src/types.ts`
6. `src/application/core/planner.ts` and `src/application/core/recovery.ts`

That path gives the shortest route from the public entry point to the execution
core.
