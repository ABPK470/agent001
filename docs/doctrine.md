# Doctrine

> **Shell owns state. Core is stateless. Dependencies are always parameters.**

This is functional-core / imperative-shell, applied twice:

1. **Monorepo** — `@mia/server` (and the UI) are the platform shell; `@mia/agent`
   and `@mia/sync` are execution cores with no HTTP/SQLite ownership.
2. **Inside `@mia/agent`** — `runtime/` is the package shell; `core/` is pure
   decisions; `domain/` is vocabulary only.

`npm run lint:arch` (`scripts/lint-arch.mjs`) enforces the hard edges below.
If a change needs a new edge, update this document first, then the lint.

---

## Monorepo rules

| Rule | Meaning |
| ---- | ------- |
| Server is composition root | Boot, Fastify, SQLite, SSE, auth, queues live in `@mia/server` |
| Agent / sync stay reusable | No ambient request context; I/O arrives via ports or host params |
| Public barrels only | Outside a package, import `@mia/agent` / `@mia/sync` — never `packages/*/src/**` |
| Ports name the I/O shape | `*Sink`, `*Store`, `*Reader`, `*Client` (see `ARCHITECTURE.md`) |
| Policies govern mutations | Allow / deny / require approval for agent tools **and** HTTP Sync preview/execute live in Policies. Sync environments are topology only (connector, role, direction). No process.env governance locks. |

---

## `@mia/agent` layers

```text
runtime  →  core, domain, ports, tools, llm, memory, internal
core     →  domain, ports, tools, internal     (not runtime*)
ports    →  domain, internal
tools    →  domain, core, runtime, ports, internal
llm      →  domain
memory   →  domain
domain   →  (self only)*
internal →  (helpers; no layer ownership)
```

\* Transitional allowlists exist in `scripts/lint-arch.mjs` for known debt
(domain type-imports of tools/core; core value-imports of `runtime/delegate`
validation). Shrink those lists; do not grow them casually.

### What each layer is for

| Layer | Owns | Must not |
| ----- | ---- | -------- |
| `domain/` | Enums, types, tenant config shapes | Services, I/O, loop drivers, `domain/services/` |
| `core/` | Pure decisions (plan, choose-path, clarify, doctrine, policy, govern, recover, delegate-decision) | Mutable loop/host state; side effects except injected ports |
| `runtime/` | Host, run context, run-a-goal spine, loop drivers, delegate drivers | Becoming a dumping ground for pure policy (put that in `core/`) |
| `ports/` | Host contracts + I/O-backed services (`AuditService`, `Learner`, memory adapters) | Agent loop control flow |
| `tools/` | Executable tools bound to host + run context | Owning the run story |
| `llm/` / `memory/` | Model adapters / context budgeting | Cross-cutting orchestration |
| `internal/` | Logger, JSON, path helpers | Business decisions |

### Naming (mature)

Use `domain/`, `ports/`, `core/`, `runtime/`, `internal/`.
Do **not** resurrect `application/`, `concepts/`, `contracts/`, or `decisions/`.
Do **not** use numeric filename prefixes (`01-…`); order lives in
`runtime/run-a-goal/run-goal.ts`.

### Outcomes, not silent fallbacks

Branches return **named outcomes**. Unhandled outcomes throw with full route
context (`UnhandledStepOutcomeError`). Recovery and retries are first-class
named paths — “no fallbacks” means no silent defaulting, not “no recovery”.

---

## `@mia/server` layers

Server is the composition root. Do **not** copy agent’s `domain/core/runtime`
everywhere. Use shell vocabulary:

```text
packages/server/src/
├── index.ts       # thin: setup CLI | startServer()
├── boot/          # process spine
├── http/          # Fastify composition
├── infra/         # long-lived I/O: db, events, queue, sandbox…
├── adapters/      # concrete @mia/agent + @mia/sync port implementations
├── api/           # product HTTP surfaces
├── ports/         # server-owned contracts
├── cli/
└── internal/      # server-only helpers
```

### Dependency direction

```text
boot      →  infra, adapters, api, ports, http, internal
http      →  api, infra, boot, ports, internal
api       →  infra, adapters, ports, boot, internal
adapters  →  infra, ports, internal
infra     →  internal, ports
ports     →  ports, internal     (not api / infra impl*)
cli       →  boot, infra, api, internal, adapters
internal  →  internal
```

\* One debt allowlist remains: `ports/orchestration.ts` → `infra/queue/` concrete
types. Shrink it; do not grow casually.

### `api/` surfaces

- Thin surface = `routes.ts` only. No empty Nest-style scaffolds.
- **`api/platform`** — operator control plane (health, about, catalog versions,
  artifact import/export). HTTP under `/api/platform/*`.
  Not `infra/` (technical capabilities). Not `deploy/` as a folder name
  (`deploy` is a business word — filenames/routes only).
- **`api/runs/prompting/`** — pure server decisions that build what the model
  sees and which tool families load (system messages, prompt gating, goal
  classification, clarification / data blocks).

### Forbidden server names

| Forbidden | Use instead |
| --------- | ----------- |
| `bootstrap/`, `app/`, `features/`, top-level `platform/`, `shared/` | `boot/`, `http/`, `api/`, `infra/`, `internal/` |
| `api/deploy/` | `api/platform/` |
| `api/runs/core/`, `**/hosting/` | `api/runs/prompting/` |
| top-level `crypto/` | `infra/` or `adapters/` |

### Prose spines

1. `boot/start-server.ts` — process life  
2. `api/runs/orchestrator.ts` + `execution/` — run life  

---

## Where state may live

Allowed:

- Fastify app and other long-lived server objects
- SQLite / adapter instances
- `AgentHost` (boot) and `RunContext` (per-run)
- Host-attached caches (`host.catalog`, …)
- Per-call locals and closures
- **Documented ambient:** agent `domain/tenant` (`getTenantConfig` /
  `setTenantConfig` / `resetTenantConfig`) — process-wide business knobs

Forbidden:

- Module-level `let` / `var` outside lint allowlists
- Exported `getGlobal*` / `setGlobal*` / `resetGlobal*`
- New `AsyncLocalStorage` for hidden dependency injection
- Module-load `setInterval` / `setTimeout` outside allowlists
- Deep imports into `packages/agent/src/**`

---

## When you add a file

**In `@mia/agent`:** pick the agent layer table (types → `domain/types`, pure
decision → `core/<cluster>`, stateful driver → `runtime/`, I/O → `ports/services`).

**In `@mia/server`:** pick shell layer (`boot` / `http` / `infra` / `adapters` /
`api/<surface>` / `ports` / `internal`). For run prompt assembly use
`api/runs/prompting/`.

Then:

1. Import only allowed layers.
2. Thread dependencies as parameters (or inject via ports / host).
3. Run `npm run lint:arch` before opening a PR.

If the file does not fit cleanly, the doctrine is wrong for that case — update
this doc and the lint together, do not sneak around the lint.

---

## `@mia/ui` layers

```text
packages/ui/src/
├── boot/         # app chrome / CSS entry
├── app/          # shell layout
├── client/       # REST + SSE client
├── state/        # zustand composition root
├── widgets/      # product surfaces (Trace, Pipelines, TermChat, …)
├── components/   # presentation-only (no store)
├── hooks/
├── lib/          # pure helpers (incl. lib/events projection)
├── theme/
└── enums/
```

| Layer | May import | Must not |
| ----- | ---------- | -------- |
| `components/` | `hooks`, `lib`, `theme`, `enums`, `components` | `state/`, `widgets/` |
| `lib/` | `enums`, `lib` | `state/`, `widgets/`, `components/` |
| `widgets/` | `client`, `state`, `app`, `components`, `hooks`, `lib`, … | reinvent wire→label maps |

Flat control flow applies (peer handlers + explicit state; no nested listener
registration on hot paths). See `.cursor/rules/first-principles.mdc`.

---

## Event catalog & outline projection

Wire identity exists once (`EventType`, `TraceEntry`). Presentation must not be
reinvented per widget — same dialect as `tool-call-presentation`
(“never branch on tool names in UI”).

**Three layers — one thought process:**

1. **Catalog (semantic only)** — `packages/shared-types/src/event-catalog.ts`.
   Every `TraceEntry.kind` and high-traffic `EventType` gets one descriptor:
   `family`, `label`, `severity`, `summary`, optional `instanceKey` (merge
   identity for the same entity, e.g. `step:frontend_layer` — **not** parent/child).
   No hierarchy, sticky, or scope-vs-leaf — those are view-local.
2. **Projection (pure)** — `packages/ui/src/lib/events/`.
   `EventAtom[]` → `buildOutline` / `buildFlatLog` driven by a **ViewSpec**:
   nest rules, `roleByFamily` / `roleByType` (`scope` | `leaf` | `omit`),
   `stickyFamilies` / `stickyTypes`, fold defaults. No React.
3. **Shell (one UI)** — `packages/ui/src/components/outline/`.
   Renders any outline; sticky = **pin overlay** (Cursor/VS Code dialect via
   `lib/events/pin.ts`), never `position: sticky` on rounded card chrome.

Widgets supply a ViewSpec + leaf body renderers (Sent JSON, SQL, tool args).
They do **not** own `switch (entry.kind)` / parallel `TRACE_KIND_LABELS` maps
for labels or outline roles.

**Phase 2:** TermChat `buildResponseParts` lives in `lib/events/build-chat-parts.ts`
(kind switches allowed there). Widgets render `ResponsePart[]` only.
Exhaustive catalog coverage is enforced by `lint:arch` (every `TraceEntry.kind`
and every `EventType` has a descriptor).

Adding a new BE event = enum member + one catalog row. Trace / Pipelines /
Event Stream / TermChat pick it up without new widget switches.

`npm run lint:arch` bans widget-level kind switches for catalogued wire kinds
outside `lib/events/` and the catalog.
