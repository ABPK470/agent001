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

> Runtime owns state; core is stateless; dependencies are always parameters.

In practice that means:

- no ambient runtime lookups (except documented `domain/tenant` getters)
- no exported module-level `setXxx(...)` mutators for boot wiring
- no new `AsyncLocalStorage` for passing hidden dependencies
- long-lived state belongs on `AgentHost` or on explicit runtime objects
- the run story lives in `runtime/run-a-goal/run-goal.ts`

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
  browserClient
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

`@mia/agent` no longer re-exports sync-owned APIs; sync callers should bind to
`@mia/sync` directly.

## Main clusters in `src/`

### `runtime/`

Stateful drivers: host, run context, `run-a-goal` loop, delegation drivers.

### `core/`

Pure decisions: plan, choose-path, clarify, doctrine, govern-tools, recover,
delegate-decision.

### `domain/`

Enums, models, domain services (policy/audit/learner), and tenant config.

### `memory/`

Token budgeting, truncation, and compaction.

### `ports/`

Contracts for host/runtime dependencies that the server and tools satisfy.

### `tools/`

Most tool implementations still live here. Tools are built with explicit host
dependencies rather than ambient setters.

### `llm/`

Model adapters implementing the `LLMClient` contract.

## Public API

The main public barrel is `src/index.ts`.

Key exports:

- `configureAgent`
- `Agent`
- tool and model contracts from `types.ts`
- curated cluster barrels

Consumers should import agent-owned APIs from `@mia/agent` and sync-owned APIs
from `@mia/sync`, not from deep source paths.

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
2. `src/index.ts`
3. `src/runtime/agent.ts` and `src/runtime/run-a-goal/`
4. `src/runtime/loop.ts` and `src/runtime/loop/`
5. `src/types.ts`
6. `src/core/plan.ts` and `src/core/recover.ts`

That path gives the shortest route from the public entry point to the execution
core.
