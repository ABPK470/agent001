# How to read `@mia/agent`

This package is the agent **execution core**: it asks a model what to do, runs
tools, checks whether the work is done, and repeats until it can answer.

## The story of one run

1. The platform (`@mia/server`) builds a **host** and a **tool list**, then
   constructs an `Agent`.
2. `Agent.run(goal)` enters **runtime/run-a-goal** — the prose spine.
3. First it may try a **planner path** (`core/choose-path`). If that answers,
   the run finishes.
4. Otherwise it enters the **tool loop**: prepare → ask model → run tools →
   after-tools (budget / recover) → check finish → repeat.
5. Pure choices (plan, clarify, govern, recover) live in **`core/`**.
   Mutable state and drivers live in **`runtime/`**.

## Folder map

| Folder | What it is | Why it exists | What happens next |
| ------ | ---------- | ------------- | ----------------- |
| `domain/` | Words, shapes, and domain services | Shared meaning across the package | Imported by core, runtime, tools |
| `ports/` | Shapes for outside dependencies | Keep I/O at the edge | Implemented by the server host |
| `core/` | Pure decisions | Testable brain; no loop state | Called from runtime steps |
| `runtime/` | Stateful drivers | Owns the loop, host, run context | Calls core; uses tools + llm |
| `tools/` | Things the agent can do | Factories bound to a host | Selected by the server registry |
| `llm/` | Model adapters | Talk to providers | Used by runtime |
| `memory/` | Prompt / transcript budgeting | Keep context under budget | Used inside the loop |
| `internal/` | Package helpers | Logging, JSON, paths | Used anywhere inside the package |

## Old → new (after reorganization)

| Old path | New path |
| -------- | -------- |
| `application/core/` | `core/` |
| `application/shell/` | `runtime/` |
| `application/core/planner*` | `core/plan/`, `core/choose-path/` |
| `application/core/governance*` | `core/govern-tools/` |
| `application/shell/agent-cluster/` | `runtime/run-a-goal/` |
| `application/shell/runtime-cluster/` | `runtime/host/` |
| `application/shell/delegation` (decision) | `core/delegate-decision/` |
| shim forests under core | deleted |
| `domain` flat services | `domain/types/`, `domain/tenant/` (services → core/policy + ports/services) |
| `tools/mssql*` | `tools/database/` |
| `tools/filesystem*` | `tools/files/` |
| `tools/shell/` | `tools/shell-command/` |
| `tools/_helpers/` | `tools/_shared/` |

## Rule

> **Runtime owns state. Core is stateless. Dependencies are always parameters.**

Outside this package, import only from `@mia/agent` (the root barrel).
