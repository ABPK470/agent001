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

## Layout

| Folder | Purpose |
| --- | --- |
| `agent/` | Per-iteration helpers used by `agent.ts`. Not a barrel. |
| `domain/` | Domain model: enums, policy, models, learner. Cluster barrel via `domain/index.ts`. |
| `planner/`, `planner-routing/` | Planner-first routing + coherent generation. |
| `loop/` | Direct tool-loop fallback. |
| `tools/` | Concrete tool implementations. |
| `tool-helpers/` | Reusable bits used by multiple tool implementations. (Note: tool-internal helpers live under `tools/_helpers/`.) |
| `delegation/`, `governance/`, `recovery/` | Cross-cutting concerns. |
| `sync/` | Sync-recipe + ABI introspection cluster. |
| `context/` | Context compaction and budgeting. |
| `internal/` | Package-private utilities (json, paths). Not exported. |

## Where things go

- **A new enum that crosses the wire** → `@mia/shared-enums`, then
  re-export in the appropriate `domain/enums/<domain>.ts`.
- **A new tool** → `tools/<name>.ts`, register through the tool registry.
- **Reusable helper for tools** → `tool-helpers/`.
- **A pure function with no domain meaning** → `internal/`.
- **Anything callers outside the package need** → must be re-exported
  through `lib/index.ts`.
