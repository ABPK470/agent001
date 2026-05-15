# `@mia/agent`

The agent runtime — the thing that drives an LLM through plan / act /
verify loops with tool use, memory, and recovery.

## Public surface

The package barrel is [`src/lib/index.ts`](src/lib/index.ts). **Outside this package,
import only from `@mia/agent`** — never reach into
`packages/agent/src/<cluster>/<file>.js` directly.

Headline exports:

- `AgentRuntime` — the long-lived container that owns LLM client, tool
  registry, attachment service, browser providers.
- `Agent` — a single run. Wraps the loop and planner routing.
- Constants in `constants.ts` — budgets, limits, retry caps.
- Cluster barrels for `domain/`, `tools/`, `planner/`, `loop/`, `sync/`,
  `governance/`, `recovery/`, `delegation/`, `context/`.

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
