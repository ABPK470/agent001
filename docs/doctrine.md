# Doctrine

> **Shell owns state. Core is stateless. Dependencies are always parameters.**  
> **Every capability has one owner. Cores receive resolved inputs — never platform folklore.**

This is the monorepo’s **contract**: what must stay true about architecture,
behavior, and evolution.  
`.cursor/rules/first-principles.mdc` is the thinking bar.  
`scripts/lint-arch/` is the machine that enforces the edges.  
**Talk is cheap:** change the contract and the lint together. Run
`npm run lint:arch` before merging.

Doctrine states **invariants**. It does not catalog past mistakes, product
anecdotes, or one-off solutions. Those live as data in the lint registries
(seams, dialects, allowlists) — general mechanisms, not prose special cases.

---

## 1. What “great” means here

The system is an **asymmetric leverage engine**: complex domain operations
become obvious, deterministic, frictionless capabilities.

### External leverage (what users feel)

| Claim | Invariant |
| ----- | --------- |
| **Zero cognitive overhead** | The surface maps 1:1 to domain concepts. No leaks of transport, storage, or implementation folklore into what people see or type. |
| **Mechanical sympathy** | The system feels durable and forgiving. Transient failure is handled with named recovery — never silent swallow. Intent and durable state are not lost. |
| **Uncompromising trust** | Correctness, security, and integrity are non-negotiable. Type escapes and dangerous sinks are not “features to add later.” |

### Internal leverage (what builders feel)

| Claim | Invariant |
| ----- | --------- |
| **Sub-linear ops** | Doubling tenants, traffic, or data must not multiply code paths. Operational variance is **data** (config, catalog, publish, deploy) — not `if (customer)` dialects. |
| **Architectural elasticity** | Core contracts are isolated from transport, storage, and UI. You can change HTTP, DB, or React without rewriting domain rules. |
| **Deterministic evolution** | New capability is **additive**: register a seam / extend an owner. Never a parallel stack that multiplies change cost. |

---

## 2. First principles (how to think)

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

Quality is respect: predictable, cohesive, cheap to change, honest about cost.
If two designs work, pick the clearer uniform one — then **lint it**.

---

## 3. Two lenses (both required)

| Lens | Question | Failure |
| ---- | -------- | ------- |
| **Structural layers** | Where may this *file* live and import? | God packages, cycles, framework leaks into domain |
| **Product seams** | Who *owns* this capability, and what do others see? | Shotgun surgery — the same optional identity painted through every layer |

Layering without ownership is unfinished architecture. **Keep layers. Require a seam.**

```text
UI → client → API (owner)
              ↓
     composition root  ──resolves──► values the core needs
              ↓
          execution core          (never heard of the owner’s private IDs)
```

---

## 4. Capability ownership (seams)

**Law.** Every product capability has **exactly one owner**.  
Changing or deleting it touches: owner + its public surface (if any) + migration
(if any) + the UI entry that called it. If you must grep the monorepo for the
same optional field to remove a feature, the owner failed.

**Resolved inputs (hard).** Execution cores receive **values** already decided
by the composition root (prompts, tool lists, budgets, ports). They do **not**
resolve platform identity, CRUD profiles, or UI picker state.

**Anti-pattern.** Optional identity fields threaded store → client → routes →
persistence → runtime → tools with no single owner. That is leakage, not layering.

**Evolution.**

- **Add** a capability → register an active seam (owner + public surface).
- **Erase** a capability → mark the seam erased with resurrection fingerprints.
- The mechanism is general. Specific seams are **registry data**, not doctrine
  paragraphs.

---

## 5. Dialects (one concept class → one home)

A **dialect** is how a concept class is expressed in code (vocabulary,
presentation, spawn, wire events, …).

**Law.** Each concept class has exactly one home. A second home is multiplicative
evolution — forbidden.

Examples of concept classes (not an exhaustive product list):

| Class | Meaning |
| ----- | ------- |
| Wire vocabulary | Event / trace identity exists once; UI projects it, does not reinvent it |
| Presentation labels | Tool/event labels for humans live in the shared presentation SoT |
| Spawn / fan-out | One kernel for child execution; planning owns *when* and *how many* |
| Policy | One governance context for mutations (tools and HTTP) |

Adding a dialect class is additive config in the lint. Duplicating an existing
class in a new folder is a doctrine violation.

---

## 6. Monorepo shape (functional core / imperative shell)

Applied twice:

1. **Monorepo** — platform shell (server + UI) owns process, HTTP, persistence,
   auth. Execution packages (`agent`, `sync`) are reusable cores: no HTTP/DB
   ownership; I/O only via ports / host parameters.
2. **Inside an execution package** — `runtime/` (or equivalent shell) owns
   loop/host state; `core/` is pure decision; `domain/` is vocabulary only.

| Rule | Meaning |
| ---- | ------- |
| Shell is composition root | Boot, transport, storage, queues, SSE live in the shell |
| Cores stay reusable | No ambient request context; thread deps as parameters |
| Public surface only | Import the package — never deep into another package’s `src/**` |
| Ports name I/O | Contracts describe sinks/stores/readers/clients; adapters implement |
| Policy governs mutation | Allow / deny / approve — default deny; admin edits policy, does not bypass it |
| Ops variance is data | Tenant/customer knobs live in config/catalog/publish — not code forks |

Do not collapse packages to make deletes “one folder.” Collapse **leaked
fields** into an owner + resolved inputs.

---

## 7. Layers (semantics)

Each package declares a **layer matrix** (enforced by lint). Doctrine defines
what layers *mean* — matrices live with the package config.

### Execution package (agent / sync pattern)

| Layer | Owns | Must not |
| ----- | ---- | -------- |
| **domain** | Types, enums, config shapes | I/O, services, loop drivers |
| **core** | Pure decisions | Mutable host/run state; side effects except via injected ports |
| **runtime** | Host, run context, loop spine | Dumping ground for pure policy (that belongs in core) |
| **ports** | I/O contracts (+ thin port-backed services where doctrine allows) | Owning the run story |
| **tools** | Executable capabilities bound to host + context | A second dialect for the same concept class |
| **adapters** (sync) | External system bindings | Business policy |
| **internal** | Helpers with no layer ownership | Business decisions |

**Elasticity:** `domain` / `core` must not value-import HTTP frameworks, UI
libraries, or DB drivers. Those belong at the shell / adapters boundary.

### Platform shell (server pattern)

| Layer | Owns |
| ----- | ---- |
| **boot** | Process life |
| **http** | Transport composition |
| **infra** | Long-lived I/O (db, events, queue, sandbox, …) |
| **adapters** | Implementations of execution-package ports |
| **api** | Product HTTP surfaces — **one capability per surface** |
| **ports** | Server-owned contracts |
| **cli** / **internal** | Operator entry / helpers |

API surfaces are thin. Domain nouns for folders — not customer brand names.
Operator control plane is a capability (platform), not a synonym for `infra/`.

### UI pattern

| Layer | Owns | Must not |
| ----- | ---- | -------- |
| **boot** / **app** | Chrome and shell layout | Business policy |
| **client** | Transport to the API | Domain presentation maps |
| **state** | Composition root for client state | Wire-kind presentation switches |
| **widgets** | Product surfaces | Reinventing wire vocabulary or tool labels |
| **components** | Presentation-only | Importing `state/` or owning wire dialects |
| **lib** | Pure helpers (including event projection) | Store coupling |
| **theme** / **enums** / **hooks** | As named | Crossing into ownership they don’t have |

UI starts work with **domain intent** (e.g. goal + thread), not platform profile
IDs. Mode and route labels are **projections** of shared vocabulary.

---

## 8. Control flow and state

### Flat control flow

Execution flows downward. Peer `onX` / `handleX` / `processX` handlers. Multi-step
interaction state lives in an **explicit object or ref** (or parameters), not
nested closures that register listeners on hot paths.

Composition roots wire listeners **once**. Do not allocate nested handlers inside
request / pointer / message paths. (Trivial one-shot `setTimeout` for logging is
not ceremony.)

### Where state may live

**Allowed:** process / app objects at the composition root; persistence;
per-run host/context; host-attached caches; locals; **documented** ambient
business knobs (tenant config pattern — process-wide, loaded at boot).

**Forbidden:** undeclared module `let`/`var`; exported `getGlobal*` / `setGlobal*`
DI; `AsyncLocalStorage` as hidden DI; module-load repeating timers without a
clear lifecycle; undeclared ambient mutable “state objects.”

---

## 9. Outcomes, failure, and trust

### Named outcomes

Branches return **named outcomes**. Unhandled outcomes fail closed with context.
Recovery and retries are first-class named paths. “No silent fallbacks” means
no quiet defaulting that discards a valid decision — not “no recovery.”

### Mechanical sympathy

Empty `catch` / `.catch(() => {})` are forbidden unless cataloged as shrinking
debt. Forgiving systems **name** failure and preserve intent; they do not
erase it.

### Trust

In pure decision layers: no `as any`, no `@ts-ignore` / `@ts-nocheck` as
policy. Dangerous sinks (`eval`, `Function`, unchecked HTML injection) are
forbidden unless explicitly allowlisted with review. Integrity is not optional.

---

## 10. Observability (first-class)

Every meaningful execution step leaves an auditable, deterministic record.

**Law.** Wire identity exists **once** (shared enums + catalog). Presentation is
projection — never a second vocabulary in widgets.

Three layers, one thought:

1. **Catalog** — semantic descriptors for every wire kind / event type  
   (`family`, `label`, `severity`, `summary`, optional instance key). No view
   hierarchy here.
2. **Projection** — pure functions: atoms → outline / log / chat parts, driven
   by a view spec.
3. **Shell** — one UI that renders projections; widgets supply view specs and
   leaf bodies, not parallel kind→label maps.

Adding a backend event = enum member + catalog row. Surfaces pick it up without
new widget switches.

---

## 11. Agent execution model (domain vocabulary)

Do not conflate:

| Term | Meaning |
| ---- | ------- |
| **Tool** | Something a loop *calls* |
| **Plan step** | Something a plan *schedules* |
| **Deterministic tool step** | Invoke one named tool with fixed args |
| **Subagent task step** | Spawn a **child agent loop** for an objective |
| **Execution mode** | *How* subagent steps run (fan-out / serial / guided / stop) |

Structure (whether to plan) and execution mode (how children run) are
**orthogonal**. Economics may change **shape** after a valid plan; it must not
silently discard the plan into an ungated direct loop. Traces must distinguish
assess outcomes from economics outcomes.

Child execution has **one** spawn kernel. Fan-out is plan DAG + mode — not a
second model-callable “parallel delegate” dialect.

---

## 12. Enforcement

Human discipline does not scale. **`npm run lint:arch`** encodes these edges.

**Runners are general** (uniform rule ids, no product `if` branches).  
**Registries hold instance data** (seams, dialects, policy tokens, debt allowlists).

Adding a capability, dialect, brand token, or catalog = add a **row** in
`scripts/lint-arch/registry/` — never a new special-case in `rules/`.

Allowlists are explicit, bounded, and must shrink. Unused entries fail.

---

## 13. Change checklist

Before merging a capability add or remove:

1. **Owner named?** One seam — not a field everywhere.  
2. **Resolved inputs?** Core sees values, not optional platform IDs.  
3. **One dialect?** No second home for the same concept class.  
4. **Named outcomes?** Decisions are distinguishable in traces and code.  
5. **Variance is data?** No new tenant/customer code fork.  
6. **Lint green?** `npm run lint:arch` — and this contract updated only if a
   *new universal edge* appeared (not because of a one-off fix).
