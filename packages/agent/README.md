# `@mia/agent`

The agent runtime — drives an LLM through plan / act / verify loops with tool
use, memory, and recovery.

## Public surface

The package barrel is [`src/index.ts`](src/index.ts). **Outside this package,
import only from `@mia/agent`** — never reach into
`packages/agent/src/<folder>/<file>.js` directly.

Headline exports:

- `configureAgent()` / `makeRunContext()` — host and per-run wiring
- `Agent` — one run (see `runtime/run-a-goal`)
- Domain types, enums, and constants
- Tool factories (`create*Tool`) — the **server** chooses which tools to bind
- Sync features are owned by `@mia/sync`; import them from that package

How to read the tree: [`src/README.md`](src/README.md).

## Layout

| Folder | Purpose |
| ------ | ------- |
| `domain/` | Enums, models, domain services (policy, audit, learner) |
| `ports/` | Contracts for host / store / client dependencies |
| `core/` | Pure decisions: plan, choose-path, clarify, doctrine, govern-tools, recover |
| `runtime/` | Stateful drivers: host, run context, run-a-goal loop, delegate |
| `tools/` | Concrete tool implementations (factories) |
| `memory/` | Context compaction and prompt budgeting |
| `llm/` | Model adapters (`LLMClient`) |
| `internal/` | Package-private utilities |

## Doctrine

> **Runtime owns state. Core is stateless. Dependencies are always parameters.**

This is functional-core / imperative-shell: the brain (`core/`) decides; the
hands (`runtime/`) drive the loop and hold mutable state.

## Tenant config

Per–mia-install JSON (`MIA_TENANT_CONFIG` → `tenant.json`): mirror schema,
routing keywords, SQL validator thresholds. Separate from `mymi-knowledge.md`
(LLM prose). Copy [`config/tenant.example.json`](config/tenant.example.json).
See [`config/TENANT-CONFIG.md`](config/TENANT-CONFIG.md). Shipped file:
[`../../deploy/tenant.json`](../../deploy/tenant.json).

## Where things go

- **A new enum that crosses the wire** → `@mia/shared-enums`, then re-export in
  `domain/enums/`.
- **A new tool** → `tools/<name>/`, export via `tools/index.ts`; register in
  `@mia/server`.
- **Reusable helper for tools** → `tools/_shared/`.
- **A pure decision with no I/O** → `core/`.
- **A stateful coordinator** → `runtime/`.
- **Anything callers outside the package need** → re-export through `src/index.ts`.
