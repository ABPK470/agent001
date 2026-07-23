# Doctrine

> **Shell owns state. Core is stateless. Dependencies are always parameters.**
> **Every product capability has one owner. Cores receive resolved inputs — never platform folklore.**

This document is the structural and product-ownership contract for the monorepo.
`.cursor/rules/first-principles.mdc` is the thinking / quality bar; this file is
where those ideas become enforceable edges. **Talk is cheap:** change this
document and `scripts/lint-arch/` together. Run `npm run lint:arch` (also
first under `npm run lint`) before merging.

---

## First principles (applied here)

Optimize for **predictability**, **cohesion**, and **low cognitive load**. The
codebase must stay **coherent, cohesive, and uniform** — one thought process
everywhere.

1. **Name the real problem** before folders or patterns. Write the real path
   first; abstract only after data and control flow are clear.
2. **One clear concept per place** — if a new engineer has to guess, the design
   is wrong. Edge cases fall out of a correct shape, not special-case sprawl.
3. Prefer the **smallest structure that still scales**; add layers only when
   the edge is real.
4. **Composition roots wire; cores stay pure.** Explicit parameters and ports
   over ambient DI, deep reference spaghetti, or indirection that hides flow.
5. **Same dialect for the same class of problem** — match neighbors or the
   change is wrong. No leftover shims, dual spawn paths, or parallel label maps.
6. **Named outcomes over silent fallbacks.** Declining a mode is not
   “fall through and hope.”
7. **Flat control flow** (UI and Node) — peer handlers, explicit state; no
   nested listener registration on hot paths. See first-principles.mdc;
   enforced by `lint:arch` (`flat-control-flow`).

Quality is respect: reliable, quiet, fast to fix, small in claim. If two designs
work, pick the clearer, more uniform, cheaper-to-change one — then **lint it**.

---

## Two kinds of architecture (both required)

| Lens | Question it answers | Failure mode |
| ---- | ------------------- | ------------ |
| **Structural layers** | Where may this *file* live and import? | God packages, cyclic deps |
| **Product seams** | Who *owns* this capability, and what do others see? | Shotgun surgery (`agentId` in 15 places) |

Layering without ownership is how a thin feature (create-agents) leaked across
UI → client → API → DB → orchestrator → traces → tools. **Keep the layers.
Require a seam.**

```text
Structural (keep)              Product seam (require)
─────────────────              ──────────────────────
UI → client → API              Feature X owned HERE (api/<surface> or nowhere)
       ↓                       Others never thread X’s private IDs
   composition root  ──resolves──► RunInputs { systemPrompt, tools, … }
       ↓
   @mia/agent / @mia/sync      Cores never heard of X
```

---

## Capability ownership (product seams)

**Rule.** Every product capability has **exactly one owner**. Deleting or
changing it should be obvious: owner module + its public HTTP (if any) +
migration (if any) + UI entry that called it. If you must grep the monorepo for
the same optional field name to remove a feature, the owner failed.

| Capability class | Owner | What others see |
| ---------------- | ----- | --------------- |
| Run lifecycle | `api/runs/` + orchestrator | `runId`, `threadId`, goal, status |
| System prompt for a run | composition root (`api/runs` / prompting) | Resolved `systemPrompt` string only |
| Planner / children | `@mia/agent` plan + spawn kernel | Plan steps, `PlanExecutionMode`, traces |
| Sync definitions | `api/sync/` + `@mia/sync` | Published defs / invoke APIs |
| Policies | `api/policies/` | Allow / deny / approval on tools & sync |
| Wire events | `@mia/shared-enums` + event catalog | `EventType` / `TraceEntry.kind` once |

### Resolved run inputs (hard)

`@mia/agent` receives **resolved** inputs for a run:

- `systemPrompt` (file-managed default today)
- governed tool list
- budgets, signals, host ports

It does **not** receive or resolve:

- CRUD “agent profile” IDs
- `resolveAgent(agentId)` / named tool whitelists from DB rows
- UI picker state

**UI / client** start a run with goal + thread (+ attachments). They do **not**
pass platform profile IDs into the agent loop.

**Anti-pattern (forbidden):** optional identity fields (`agentId`, …) painted
through store → client → routes → SQLite → ActiveRun → delegate tools →
usage/admin labels with no single owner. That is shotgun surgery, not layering.

**Historical lesson:** multi-agent CRUD (`agent_configs`, `/api/agents`,
AgentEditor) was erased. Do not resurrect it. Specialization is planner
`subagent_task` + spawn kernel, not prompt-profile rows.

`lint:arch` enforces capability ownership via the **seams registry**
(`scripts/lint-arch/seams.mjs`): erased seams carry resurrection fingerprints;
active API surfaces must be registered. Do not grow one-off identifier bans in
rule files — add or erase a seam row.

---

## Agent runtime model (planner + children)

### Vocabulary (do not conflate)

| Term | Meaning |
| ---- | ------- |
| **Tool** | Something an agent *calls* (`query_mssql`, `read_file`, …) |
| **Plan step** | Something the *plan schedules* |
| **`deterministic_tool`** | Step that invokes one named tool with fixed args |
| **`subagent_task`** | Step that spawns a **child agent loop** for an objective |
| **`PlanExecutionMode`** | *How* `subagent_task` steps run: `parallel` \| `serial` \| `guided` \| `stop` |

A step is **not** a tool. Modes are **not** tools.

### Two orthogonal axes

```text
Tier 0 — Structure (cheap, before plan LLM)     assessPlannerDecision
  direct   → parent tool loop; no plan
  planner  → generate and KEEP a plan

Tier 1 — Execution mode (after valid plan)      runDelegationGate
  parallel → fan out subagent_task (maxParallel N)
  serial   → one child at a time; normal envelopes / tool allowlists
  guided   → serial + child’s tools widened to full parent set (thin steps)
  stop     → safety / hard-block; fail closed
```

**Never** after a valid plan: soft-decline economics → discard plan → silent
direct-loop fallback. Economics only changes **shape**. Traces must distinguish
`assess` direct from `economics_serial` / `economics_guided` (not one vague
`planner_declined` for both).

Tier 0 cannot answer Tier 1: fan-out economics needs plan shape (step count,
deps, parallel fraction). Folding full economics into assess is wrong.

### One spawn kernel

- **One** child execution path: `tools/delegate-spawn/spawn.ts` (`ChildContract`).
- Planner adapter (`spawn-for-plan`) builds the contract from envelope + step.
- **No** parent mid-loop `delegate` / `delegate_parallel` tools — those were a
  weaker ungated bypass and a second dialect.
- Parallelism for children is the **pipeline DAG** + `PlanExecutionMode`, not
  a model-callable parallel tool.
- Parent ↔ child communication: return `DelegateResult` + pipeline
  verify/repair (primary). Optional bus is coordination/UI, not the core contract.

---

## Monorepo rules

This is functional-core / imperative-shell, applied twice:

1. **Monorepo** — `@mia/server` (and the UI) are the platform shell; `@mia/agent`
   and `@mia/sync` are execution cores with no HTTP/SQLite ownership.
2. **Inside `@mia/agent`** — `runtime/` is the package shell; `core/` is pure
   decisions; `domain/` is vocabulary only.

| Rule | Meaning |
| ---- | ------- |
| Server is composition root | Boot, Fastify, SQLite, SSE, auth, queues live in `@mia/server` |
| Agent / sync stay reusable | No ambient request context; I/O arrives via ports or host params |
| Public barrels only | Outside a package, import `@mia/agent` / `@mia/sync` — never `packages/*/src/**` |
| Ports name the I/O shape | `*Sink`, `*Store`, `*Reader`, `*Client` (see `ARCHITECTURE.md`) |
| Policies govern mutations | Allow / deny / require approval for agent tools and HTTP Sync share one `buildPolicyContext` (always default-deny). Admin edits Policies; admin does not bypass them. Factory seed is `deploy/policies/defaults.json` (boot insert-if-missing only); DB/UI is SoT afterward. Platform → Reset factory policy defaults re-reads that JSON on purpose — never silent refresh on boot. `AGENT_HOSTED_MODE` is workspace isolation only. |

Do **not** collapse packages to make deletes “one folder.” Collapse **leaked
fields** into an owner + resolved inputs instead.

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

\* Transitional allowlists live in `scripts/lint-arch/config.mjs` for known debt
(domain type-imports of tools/core; core value-imports of `runtime/delegate`
validation). Unused entries fail — allowlists must shrink; do not grow them casually.

### External Leverage (machine-enforced)

User-facing product quality — same rule as Internal Leverage: **closed
invariants**, not slogans. Lint cannot prove “feels instant”; it enforces the
structural proxies that keep external leverage from rotting.

| Claim | Meaning | Enforcement |
| ----- | ------- | ----------- |
| **Zero cognitive overhead** | Domain surface maps 1:1 to shared vocabulary; no platform jargon in UI | `surface-enum-fork`, `surface-jargon`; wire-events dialect; seams erase folklore IDs |
| **Mechanical sympathy** | Failures are named and observed — never silently swallowed | `sympathy-silent-failure` (empty `catch` / `.catch(() => {})`) |
| **Uncompromising trust** | Correctness escapes and dangerous sinks are forbidden in pure layers | `trust-as-any`, `trust-ts-escape`, `trust-dangerous-sink` (`eval` / `Function` / `dangerouslySetInnerHTML`) |

Config: `scripts/lint-arch/external.mjs` + shrinking debt in
`scripts/lint-arch/external-debt.mjs`. Adding a new jargon pattern or sink is
**config**, not a new special-case rule.

### Internal Leverage (machine-enforced)

These three claims are **closed doctrine edges**, not slogans. Lint cannot prove
traffic curves; it enforces the structural proxies that keep leverage true.

| Claim | Meaning | Enforcement |
| ----- | ------- | ----------- |
| **Architectural elasticity** | Core/domain contracts stay free of HTTP, React, DB drivers; packages import only public `exports` | `elasticity-framework`, `elasticity-exports`, `elasticity-deep-import`, `elasticity-resolved-inputs`; import cycles fail unless in shrinking `cycle-debt.mjs` |
| **Deterministic evolution** | One owner per capability; one dialect per concept; additive seams | `scripts/lint-arch/seams.mjs` registry (`seam-unregistered`, `seam-erased`, `seam-owner-unique`); dialect classes (`dialect-presentation-labels`, `dialect-spawn-kernel`, `dialect-wire-events`) |
| **Sub-linear ops** | Tenant/customer variance is data, not code forks | `ops-tenant-identity-fork`, `ops-branded-surface`; ambient module state linted on all packages |

**Seams registry (SSOT):** every `api/<surface>/` must be an **active** seam.
Erased capabilities are **rows** (`status: "erased"` + fingerprints) — the runner
is general; agent-profiles is one erased seam, not a special-case ban list in
`product.mjs`. Adding a capability = add a seam (additive). Erasing one = flip
status + fingerprints.

**Dialect classes:** presentation labels (tool/wire), spawn kernel, wire-events
each have exactly one home path. A second home fails.

### `lint:arch` (how doctrine stays true)

`scripts/lint-arch.mjs` is the asymmetric enforcement engine — not a regex police
officer. It parses TypeScript via the compiler API, resolves modules with
`ts.resolveModuleName`, and applies one package config schema across agent /
server / sync / ui.

| Edge | How |
| ---- | --- |
| Layer matrix + side-effect imports | AST import/export declarations |
| Import cycles (incl. intra-layer) | Value-import graph; fail unless shrinking cycle allowlist |
| Flat control flow | AST function nesting + listener registration |
| Module `let` / timers / ALS | AST statements (all packages); ALS ban on agent |
| Seams / erased capabilities | Registry in `scripts/lint-arch/seams.mjs` |
| Dialect uniqueness | Concept-class owners in seams registry |
| Domain surface / silent failure / trust | External Leverage (`scripts/lint-arch/external.mjs`) |
| Event catalog coverage | Every `TraceEntry.kind` / `EventType` has a descriptor |
| Stale debt allowlists | Unused allowlist entries fail |

Change this document and `scripts/lint-arch/` together.

### What each layer is for

| Layer | Owns | Must not |
| ----- | ---- | -------- |
| `domain/` | Enums, types, tenant config shapes | Services, I/O, loop drivers, `domain/services/` |
| `core/` | Pure decisions (plan, choose-path, clarify, doctrine, policy, govern, recover, delegate-decision) | Mutable loop/host state; side effects except injected ports |
| `runtime/` | Host, run context, run-a-goal spine, loop drivers | Dumping ground for pure policy (put that in `core/`) |
| `ports/` | Host contracts + I/O-backed services (`AuditService`, `Learner`, memory adapters) | Agent loop control flow |
| `tools/` | Executable tools bound to host + run context; **one** spawn kernel under `delegate-spawn/` | Owning the run story; a second ad-hoc delegate tool dialect |
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
├── api/           # product HTTP surfaces (capability owners)
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
ports     →  ports, internal     (not api / infra impl)
cli       →  boot, infra, api, internal, adapters
internal  →  internal
```

Layer allowlists for server are empty — do not reintroduce ports→infra debt casually.

### `api/` surfaces

- Thin surface = `routes.ts` only. No empty Nest-style scaffolds.
- **One capability per `api/<surface>`** — that folder is the owner (see
  Capability ownership).
- **`api/platform`** — operator control plane (health, about, catalog versions,
  artifact import/export). HTTP under `/api/platform/*`.
  Not `infra/` (technical capabilities). Not `deploy/` as a folder name
  (`deploy` is a business word — filenames/routes only).
- **`api/runs/prompting/`** — pure server decisions that build what the model
  sees and which tool families load (system messages, prompt gating, goal
  classification, clarification / data blocks). Resolves run inputs here /
  in run start — not in the UI.
- **`api/tools/`** — tool catalog listing (`GET /api/tools`). Not agent CRUD.
- **Forbidden:** `api/agents/` (erased seam `agent-profiles` in
  `scripts/lint-arch/seams.mjs` — do not resurrect).

### Forbidden server names

| Forbidden | Use instead |
| --------- | ----------- |
| `bootstrap/`, `app/`, `features/`, top-level `platform/`, `shared/` | `boot/`, `http/`, `api/`, `infra/`, `internal/` |
| `api/deploy/` | `api/platform/` |
| `api/agents/` | (deleted — one system prompt, planner children) |
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
- Deep imports into `packages/*/src/**` outside public barrels

---

## When you add a file

**In `@mia/agent`:** pick the agent layer table (types → `domain/types`, pure
decision → `core/<cluster>`, stateful driver → `runtime/`, I/O → `ports/services`).

**In `@mia/server`:** pick shell layer (`boot` / `http` / `infra` / `adapters` /
`api/<surface>` / `ports` / `internal`). For run prompt assembly use
`api/runs/prompting/`. Ask: **which capability owns this?** If none, you are
about to leak.

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

UI starts runs with **goal + thread (+ attachments)** only. No agent-profile
picker; no `selectedAgentId`. Planner route / subagent mode are **trace
projections** (catalog + `lib/events`), not local folklore maps.

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

TermChat `buildResponseParts` lives in `lib/events/build-chat-parts.ts`
(kind switches allowed there). Widgets render `ResponsePart[]` only.
Exhaustive catalog coverage is enforced by `lint:arch` (every `TraceEntry.kind`
and every `EventType` has a descriptor).

Adding a new BE event = enum member + one catalog row. Trace / Pipelines /
Event Stream / TermChat pick it up without new widget switches.

`PlanExecutionMode` lives in `@mia/shared-enums`. UI labels for
`planner-delegation-decision` come from the catalog / projections
(`parallel` / `serial` / `guided` / `stop` — “Subagent mode”), not ad-hoc
“will delegate / skip” copy.

`npm run lint:arch` bans widget-level kind switches for catalogued wire kinds
outside `lib/events/` and the catalog.

---

## Change cost checklist

Before merging a capability add/remove:

1. **Owner named?** One `api/<surface>` or agent module — not “a field everywhere.”
2. **Resolved inputs?** Core sees values, not optional platform IDs.
3. **One dialect?** No second spawn path, second label map, or silent fallback.
4. **Named outcomes?** Assess vs economics vs stop are distinguishable in traces.
5. **Lint green?** `npm run lint:arch` — and doctrine updated if you needed a new edge.
