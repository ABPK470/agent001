# Doctrine

> **Shell owns state. Core is stateless. Dependencies are always parameters.**  
> **Every capability has one owner. Cores receive resolved inputs — never platform folklore.**

The monorepo contract: invariants for architecture and evolution.

---

## 1. What “great” means here

The system turns complex domain operations into obvious, deterministic,
frictionless capabilities.

### External (what users feel)

| Claim | Invariant |
| --- | --- |
| **Zero cognitive overhead** | Surfaces map 1:1 to domain concepts. Transport, storage, and implementation folklore do not leak into what people see or type. |
| **Mechanical sympathy** | Durable and forgiving. Transient failure uses named recovery — never silent swallow. Intent and durable state are not lost. |
| **Uncompromising trust** | Correctness, security, and integrity are non-negotiable. Type escapes and dangerous sinks are not deferred work. |

### Internal (what builders feel)

| Claim | Invariant |
| --- | --- |
| **Sub-linear ops** | Doubling tenants, traffic, or data must not multiply code paths. Operational variance is **data** (config, catalog, publish) — not `if (customer)` dialects. |
| **Architectural elasticity** | Core contracts stay isolated from transport, storage, and UI. Those can change without rewriting domain rules. |
| **Deterministic evolution** | New capability is **additive**: register a seam or extend an owner. Never a parallel stack that multiplies change cost. |

---

## 2. First principles

1. **Name the real problem** before folders or patterns. Write the real path;
   abstract only after data and control flow are clear.
2. **One clear concept per place.** If a new engineer must guess, the design is
   wrong. Edge cases fall out of a correct shape — not special-case sprawl.
3. **Smallest structure that still scales.** Add layers only when the edge is real.
4. **Composition roots wire; cores stay pure.** Explicit parameters and ports.
   No ambient DI that hides flow.
5. **Same dialect for the same class of problem.** Match neighbors or the
   change is wrong.
6. **Named outcomes over silent fallbacks.** Declining a mode is not
   “fall through and hope.”
7. **Flat control flow** (UI and Node): peer handlers, explicit state; no nested
   listener registration on hot paths.
8. **ESM only** in package sources (`"type": "module"`). Bare `require(...)` /
   `import x = require(...)` are forbidden — they typecheck via `@types/node`
   but throw at runtime. Use `import`.

When two designs work, pick the clearer, more uniform, quieter one.

---

## 3. Two lenses (both required)

| Lens | Question | Failure |
| --- | --- | --- |
| **Structural layers** | Where may this *file* live and import? | God packages, cycles, framework leaks into domain |
| **Product seams** | Who *owns* this capability, and what do others see? | Shotgun surgery — the same optional identity painted through every layer |

Layering without ownership is unfinished architecture.

```text
UI → client → API (owner)
              ↓
     composition root  ──resolves──► values the core needs
              ↓
          execution core          (never heard of the owner’s private IDs)
```

---

## 4. Capability ownership (seams)

**Law.** Every product capability has **exactly one owner**. Changing or deleting
it touches: owner + its public surface (if any) + migration (if any) + the UI
entry that called it. If removing a feature requires grepping the monorepo for
the same optional field, the owner failed.

**Resolved inputs.** Execution cores receive **values** already decided by the
composition root (prompts, tool lists, budgets, ports). They do not resolve
platform identity, CRUD profiles, or UI picker state.

**Anti-pattern.** Optional identity fields threaded store → client → routes →
persistence → runtime → tools with no single owner. That is leakage, not layering.

**Owned identities.** A cross-package `*Id` has exactly one owning capability.
Erasing a capability removes its identities — they must not reappear as folklore.

**Evolution.**

- **Add** a capability → one owner + its public surface.
- **Erase** a capability → remove the owner and surface; do not leave identity folklore behind.

---

## 5. Dialects

A **dialect** is how a concept class is expressed (vocabulary, presentation,
spawn, wire events, …).

**Law.** Each concept class has exactly one home. A second home is multiplicative
evolution — forbidden.

| Class | Meaning |
| --- | --- |
| Wire vocabulary | Event / trace identity exists once; UI projects it |
| Presentation labels | Human labels for tools/events live in the shared presentation source of truth |
| Spawn / fan-out | One kernel for child execution; planning owns *when* and *how many* |
| Policy | One governance context for mutations (tools and HTTP) |

Duplicating an existing class in a new folder is a doctrine violation.

---

## 5b. Viewing as (Personal vs Platform)

One owned concept in the platform shell. Same words in UI, code, and docs.

| Term | Meaning |
| --- | --- |
| **Viewing as** | Whose **Personal** data the app shows. **Me** or another user’s display name. |
| **Me** | Viewing as the signed-in session (`session.upn`). Default. |
| **Personal** | Work product (threads, runs, Env Sync history, pipelines, live logs). Follows Viewing as. |
| **Platform** | Shared deploy truth (policies, entity registry, connectors, Sync Admin, Usage, Audit, Active Users). Ignores Viewing as. |

**Owner (server):** auth composition root — `registerViewingAs` + `personal.read` / `personal.write` preHandlers. Resolve once onto `req.viewingAs`. Handlers only call `viewingAsOf(req)` (or ignore Viewing as for Me-only writes). They never call `resolveViewingAs` and never re-check the header.

**Owner (UI):** app chrome (`viewingAsUpn` / Viewing as control). Widgets may read `isViewingAsOther` for quiet chrome (disable Personal writes). Not widgets as scope owners. Not agent/sync cores. Do not pass `userId` into widgets.

**Transport:** `X-Viewing-As` on fetch; `?viewingAs=` for EventSource (cannot set headers). Omit when Me.

**Laws:** Personal routes **declare** `personal.read` or `personal.write` at registration. Lists/gets/SSE filter to Viewing as UPN. Personal writes only when Me (`personal.write`). Platform routes omit those preHandlers and never read Viewing as. Admin keeps their own dashboard layout when Viewing as someone else.

**Do not call it** workspace subject, inspect, fleet, impersonation, or context switcher.

---

## 6. Monorepo shape (functional core / imperative shell)

Applied twice:

1. **Monorepo** — platform shell (`server` + `ui`) owns process, HTTP,
   persistence, auth. Execution packages (`agent`, `sync`, `connectors`) are
   reusable cores: no HTTP/DB ownership of the product; I/O only via ports /
   host parameters.
2. **Inside an execution package** — `runtime/` owns loop/host state; `core/` is
   pure decision; `domain/` is vocabulary only.

| Rule | Meaning |
| --- | --- |
| Shell is composition root | Boot, transport, storage, queues, SSE live in the shell |
| Cores stay reusable | No ambient request context; thread deps as parameters |
| Public surface only | Import the package — never deep into another package’s `src/**` |
| Ports name I/O | Contracts describe sinks/stores/readers/clients (and named ports/providers/registries); adapters implement |
| Policy governs mutation | Allow / deny / approve — default deny; admin edits policy, does not bypass it |
| Ops variance is data | Tenant/customer knobs live in config/catalog/publish — not code forks |

Do not collapse packages to make deletes “one folder.” Collapse **leaked
fields** into an owner + resolved inputs.

---

## 7. Layers

Each package declares a layer matrix. Doctrine defines what layers *mean*;
matrices live with package config.

### Execution package (agent / sync)

| Layer | Owns | Must not |
| --- | --- | --- |
| **domain** | Types, enums, config shapes | I/O, services, loop drivers |
| **core** | Pure decisions | Mutable host/run state; side effects except via injected ports |
| **runtime** | Host, run context, loop spine | Dumping ground for pure policy (that belongs in core) |
| **ports** | I/O contracts | Owning the run story |
| **tools** | Executable capabilities bound to host + context | A second dialect for the same concept class |
| **adapters** | External system bindings | Business policy |
| **internal** | Helpers with no layer ownership | Business decisions |

`domain` / `core` must not value-import HTTP frameworks, UI libraries, or DB
drivers. Those belong at the shell / adapters boundary.

### Platform shell (server)

| Layer | Owns |
| --- | --- |
| **boot** | Process life |
| **http** | Transport composition |
| **infra** | Long-lived I/O (db, events, queue, sandbox, …) |
| **adapters** | Implementations of execution-package ports |
| **runtime** | Run orchestration, prompt assembly, tooling, workspace execution |
| **api** | Product HTTP surfaces — **one capability per surface** |
| **ports** | Server-owned contracts |
| **cli** / **internal** | Operator entry / helpers |

API surfaces are thin. Domain nouns for folders. Operator control plane is a
capability (`platform`), not a synonym for `infra/`.

### UI

| Layer | Owns | Must not |
| --- | --- | --- |
| **boot** / **app** | Chrome and shell layout | Business policy |
| **client** | Transport to the API | Domain presentation maps |
| **state** | Composition root for client state | Wire-kind presentation switches |
| **widgets** | Product surfaces | Reinventing wire vocabulary or tool labels |
| **components** | Presentation-only | Importing `state/` or owning wire dialects |
| **lib** | Pure helpers (including event projection) | Store coupling |
| **theme** / **enums** / **hooks** | As named | Crossing into ownership they don’t have |

UI starts work with **domain intent** (goal + thread), not platform profile IDs.
Mode and route labels are **projections** of shared vocabulary.

---

## 8. Control flow and state

### Flat control flow

Execution flows downward. Peer `onX` / `handleX` / `processX` handlers.
Multi-step interaction state lives in an **explicit object or ref** (or
parameters), not nested closures that register listeners on hot paths.

Composition roots wire listeners **once**. Do not allocate nested handlers
inside request / pointer / message paths. Trivial one-shot delays for logging
are not ceremony.

### Lifecycle, cancellation, handles

**Fire-and-forget** work must be scoped: name failure (`.catch` / supervised
task). Dangling promises are not “background.”

**Cancellation flows downhill.** Subpaths that perform I/O take an
`AbortSignal` (or equivalent) from the parent.

**Host handles** (intervals, servers, pools, watchers) have a clear owner and a
reachable dispose/clear on the same lifecycle.

### Where state may live

**Allowed:** process / app objects at the composition root; persistence;
per-run host/context; host-attached caches; locals; **documented** ambient
business knobs loaded at boot (tenant config pattern).

**Forbidden:** undeclared module `let`/`var`; exported `getGlobal*` /
`setGlobal*` DI; undeclared ambient mutable “state objects”; module-load
repeating timers without a clear lifecycle; CommonJS `require(...)` /
`import = require(...)` in ESM packages (use `import`; `createRequire` only
via package `cjsRequireAllowlist` when a native CJS-only dependency forces it).

---

## 9. Outcomes, failure, and trust

### Named outcomes

Branches return **named outcomes**. Unhandled outcomes fail closed with
context. Recovery and retries are first-class named paths. “No silent
fallbacks” means no quiet defaulting that discards a valid decision — not
“no recovery.”

### Mechanical sympathy

Empty `catch` / `.catch(() => {})` are forbidden. Forgiving systems **name**
failure and preserve intent; they do not erase it.

### Error codes

Stable machine `code` values live in a registry (shared enums / domain error
modules). Product code imports them — it does not invent `UPPER_SNAKE`
literals at throw/emit sites.

### Trust

In pure decision layers: no `as any`, no `@ts-ignore` / `@ts-nocheck` as
policy. Dangerous sinks (`eval`, `Function`, unchecked HTML injection) are
forbidden.

At trust boundaries (HTTP, client transport, persisted JSON), decode through a
**named boundary helper** that yields `unknown` — never `JSON.parse(...) as T`.
Validate before use.

Domain identities that cross the stack are **branded** in domain/core (not bare
`string` for registered `*Id`s). Wire DTOs may still serialize to string.

Ports name contracts. They do not import concrete `infra/` / driver stacks.

### Determinism (decision layers)

`domain` / `core`: no unseeded entropy (`Math.random`, `randomUUID`). Iteration
that affects outcomes over maps/key sets is ordered explicitly. Wall-clock for
traces may live at the shell; decision RNG is a parameter.

### Secrets

Do not log or emit raw secret-bearing properties. Redact at the sink.

---

## 10. Observability

Every meaningful execution step leaves an auditable, deterministic record.

**Law.** Wire identity exists **once** (shared enums + catalog). Presentation is
projection — never a second vocabulary in widgets.

1. **Catalog** — semantic descriptors for every wire kind (`family`, `label`,
   `severity`, `summary`, optional instance key). No view hierarchy here.
2. **Projection** — pure functions: atoms → outline / log / chat parts, driven
   by a view spec.
3. **Shell** — one UI that renders projections; widgets supply view specs and
   leaf bodies, not parallel kind→label maps.

Adding a backend event = enum member + catalog row. Surfaces pick it up without
new widget switches.

---

## 11. Agent execution vocabulary

Do not conflate:

| Term | Meaning |
| --- | --- |
| **Tool** | Something a loop *calls* |
| **Plan step** | Something a plan *schedules* |
| **Deterministic tool step** | Invoke one named tool with fixed args |
| **Subagent task step** | Spawn a **child agent loop** for an objective |
| **Execution mode** | *How* subagent steps run (fan-out / serial / guided / stop) |

Structure (whether to plan) and execution mode (how children run) are
**orthogonal**. Economics may change **shape** after a valid plan; it must not
silently discard the plan into an ungated direct loop. Traces distinguish
assess outcomes from economics outcomes.

Child execution has **one** spawn kernel. Fan-out is plan DAG + mode — not a
second model-callable “parallel delegate” dialect.
