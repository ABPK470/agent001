# `@mia/agent`

The agent runtime — the thing that drives an LLM through plan / act /
verify loops with tool use, memory, and recovery.

## Public surface

The package barrel is [`src/index.ts`](src/index.ts). **Outside this package,
import only from `@mia/agent`** — never reach into
`packages/agent/src/<cluster>/<file>.js` directly.

Headline exports:

- `configureAgent()` / `makeRunContext()` — explicit host and per-run
  wiring for tools, ports, and run-scoped state.
- `Agent` — a single run. Wraps the loop and planner routing.
- Constants and shared runtime types from `domain/agent-constants.ts` and
  `src/types.ts`.
- Cluster barrels for the proposal-aligned `application/`, `domain/`, `tools/`,
  `memory/`, `llm/`, and `internal/` surfaces.
- Sync features are owned by `@mia/sync`; import them from that package,
  not from `@mia/agent`.

## Layout

| Folder               | Purpose                                                                             |
| -------------------- | ----------------------------------------------------------------------------------- |
| `application/core/`  | Stateless planner, doctrine, clarify, and recovery logic.                           |
| `application/shell/` | Stateful loop and runtime wiring, including `Agent` and `configureAgent()`.         |
| `domain/`            | Domain model: enums, policy, models, learner. Cluster barrel via `domain/index.ts`. |
| `ports/`             | Contracts for host/runtime dependencies exposed by the agent package.               |
| `tools/`             | Concrete tool implementations.                                                      |
| `memory/`            | Context compaction, budgeting, and transcript state.                                |
| `llm/`               | Model adapters implementing the `LLMClient` contract.                               |
| `internal/`          | Package-private utilities.                                                          |

## Tenant config

Per–mia-install JSON (`MIA_TENANT_CONFIG` → `tenant.json`): mirror schema, routing
keywords, SQL validator thresholds. Separate from `mymi-knowledge.md` (LLM prose).
Copy [`config/tenant.example.json`](config/tenant.example.json) like `.env.example`.
See [`config/TENANT-CONFIG.md`](config/TENANT-CONFIG.md). Shipped MyMI file:
[`../../deploy/tenant.json`](../../deploy/tenant.json).

## Where things go

- **A new enum that crosses the wire** → `@mia/shared-enums`, then
  re-export in the appropriate `domain/enums/<domain>.ts`.
- **A new tool** → `tools/<name>.ts`, register through the tool registry.
- **Reusable helper for tools** → `tool-helpers/`.
- **A pure function with no domain meaning** → `internal/`.
- **Anything callers outside the package need** → must be re-exported
  through `src/index.ts`.
