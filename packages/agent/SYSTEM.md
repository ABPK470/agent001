# Agent System

`@mia/agent` is the execution core: the model-plus-tools loop, planning,
recovery, delegation, governance, and most tool implementations. It does not
own HTTP, product persistence, or sync/connectors engines — those arrive
through ports and the host.

---

## Rule

> Runtime owns state. Core is stateless. Dependencies are always parameters.

- Long-lived capabilities live on **`AgentHost`**
- Per-run facts live on **`RunContext`**
- Pure decisions live in **`core/`**
- The documented ambient exception is **`TenantConfig`** (business knobs loaded
  once at boot)

---

## Package boundaries

| Package | Role relative to agent |
| --- | --- |
| `@mia/server` | Shell — builds the host, adapters, orchestrator, API |
| `@mia/agent` | Execution loop, tools, memory, LLM clients |
| `@mia/sync` | Sibling — metadata preview/execute; agent calls sync tools, does not own sync |
| `@mia/connectors` | Sibling — Bridge data movement; agent calls through `ConnectorPort` |
| `shared-*` | Wire contracts |

Import `@mia/agent` only through its public barrel. Sync- and connectors-owned
APIs come from those packages, not re-exported folklore.

---

## Layers

| Layer | Owns |
| --- | --- |
| `domain/` | Enums, types, tenant / published-sync vocabulary |
| `core/` | Pure decisions — plan, choose-path, clarify, doctrine, policy, govern-tools, recover, delegate gates, goal intent |
| `runtime/` | `configureAgent` / `AgentHost` / `RunContext`, goal loop, delegation drivers |
| `ports/` | Host contracts; audit / learner / memory adapter shapes |
| `tools/` | Executable capabilities (filesystem, shell, MSSQL, catalog, Bridge, human-in-the-loop, delegation, …) |
| `memory/` | Compaction, tiers, prompt budget |
| `llm/` | Model clients |
| `internal/` | Package helpers |

---

## Host and run context

**`AgentHost`** (once per process) holds process-lifetime capabilities: workspace,
MSSQL, filesystem, shell, user input, attachments, catalog, sync façade,
connectors, tenant identity. Unwired capabilities are null.

**`RunContext`** (once per run) holds abort signal, memory writer, tool trace,
policy context, and sync-op context. Threaded into every tool handler.

Tools are constructed with host + context already bound. Lookup is a map of
name → tool built at construction — not ambient registration.

---

## How a goal runs

1. Prepare messages (goal + system blocks).
2. Choose path — direct answer vs tool loop (named outcomes).
3. Tool loop — ask model → decide next action → run tools → recover / stuck
   checks → repeat until finish.
4. Finish — answer plus usage.

Every branch returns a named outcome. Unhandled outcomes fail closed with
route state.

---

## Public surface

Consumers import from `@mia/agent`: `configureAgent`, `Agent`, tool and model
contracts, curated domain/runtime helpers. Deep imports into `src/**` are not
supported.

---

## Reading order

1. [docs/doctrine.md](../../docs/doctrine.md)
2. [ARCHITECTURE.md](../../ARCHITECTURE.md)
3. Package public barrel (`src/index.ts`)
4. `runtime/` (host + run-a-goal)
5. `core/plan/` and `core/recover/`
