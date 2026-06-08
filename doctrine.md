# Architecture Doctrine

> The contract every file in this monorepo follows. Read this once; every
> later naming, layout, and lint rule is a corollary.

---

## 1. The one rule

> **Shell owns state; core is stateless; dependencies are always parameters.**

That's it. Everything else in this document either restates this rule, applies
it to a specific case, or enforces it mechanically.

Three plain-English consequences:

1. **Shell** (imperative, classes) — owns identity, lifecycle, I/O, mutable
   state. Built at boot. Few in number.
2. **Core** (functional, plain functions and closure factories) — no
   module-level state, no setters, no `AsyncLocalStorage`. If a function
   needs `X`, `X` is in its signature.
3. **Dependencies travel as parameters**, never as ambient context. Think of
   it as a C `Context*` threaded through every call. No globals. No
   service locator.

## 2. Core/shell is fractal — it applies at two levels

This is the load-bearing concept of the whole architecture.

### Level 1 — the system

```
┌────────────────────────────────────────────────────┐
│                @mia/server  (SHELL)                 │
│      HTTP routes · SQLite · SSE · channels          │
│      ┌──────────────────────────────────────┐       │
│      │       @mia/agent  (CORE)              │      │
│      │  agent loop · planner · tool logic    │      │
│      └──────────────────────────────────────┘       │
└────────────────────────────────────────────────────┘
```

`@mia/agent` declares **ports** (interfaces describing what the core needs
from the world). `@mia/server` provides **adapters** (concrete
implementations bridging the ports to real technology). Lint-enforced
one-way dependency: adapters import ports; ports never import adapters.

### Level 2 — inside each package

Every package has its own core/shell split:

```
packages/agent/src/
  core/        ← pure functions only (planner, recovery, diff, prompt builders)
  shell/       ← stateful, I/O-adjacent (Agent class, host, llm clients, tool closures)
  ports/       ← interface declarations only (sinks/, stores/, readers/, clients/)

packages/server/src/
  core/        ← pure orchestration rules, policy evaluation, lifecycle state machines
  shell/       ← Fastify routes, SQLite, SSE broadcaster, channel webhooks
  adapters/    ← implementations of @mia/agent ports
```

### The purity test (the one rule that places every file)

> A file belongs in `core/` if **all** its exports are pure: same input →
> same output, no I/O, no global state, no clock, no random, no mutation
> visible outside the call.
>
> Otherwise it belongs in `shell/`.

Consequences:

- A pure utility (`parseToolArgs`) inside the server package goes in
  `packages/server/src/core/`. Package location does **not** determine
  core-ness; purity does.
- A stateful driver (`Agent` class holding the loop) inside the agent
  package goes in `packages/agent/src/shell/`. Owning state makes it
  shell even though it's the agent's main abstraction.

When in doubt: would this be trivial to unit-test with no mocks? If yes,
core. If you'd need to mock something or set up a fixture, shell.

## 3. Ports & Adapters (without the jargon)

We use Ports & Adapters as our architectural style. The core declares
interfaces describing what it needs from the outside (**ports**); the
shell provides concrete implementations (**adapters**). The boundary is
enforced by the package layout and one lint rule.

**Why P&A even when each port has only one production adapter?** The
benefits are not "swap implementations at runtime" (we rarely do). The
benefits are:

1. **Dependency direction is enforced** — the agent package has zero
   imports from the server. The build graph stays acyclic; refactors stay
   local.
2. **Tests get a free fake** — every port has a `FakeXxx` in tests. Unit
   tests are fast and hermetic.
3. **The contract is named and small** — `AuditStore` is four methods.
   Without P&A, the core would depend on the SQLite helper directly,
   which is forty functions plus a connection-pool detail.
4. **Future extraction is free** — when `@mia/sync` becomes its own
   package, the ports already exist. Extraction becomes mechanical.
5. **Reasoning locality** — reading the core, you see *"I emit a
   `SyncEventSink`"*. You don't need to know SSE, the `event_log` table,
   or webhooks exist.

**When does a type get to be a port?** Only when:
- it crosses the core/shell package boundary, **or**
- tests need to fake it.

Otherwise it's a plain function. This prevents "interface for interface's
sake". Expected count of real ports in this codebase: ~15–20, not 200.

## 4. Naming — four suffixes, all industry-standard

Ports are named by the **communication shape** they implement. There are
exactly four shapes in this codebase, each with one suffix:

| Suffix | Communication shape | Examples |
|---|---|---|
| **`*Sink`** | Event push — fire-and-forget, no return value, failures must not propagate | `SyncEventSink`, `SseSink` |
| **`*Store`** | Read + write the same entity (persistence) | `AuditStore`, `SyncPlanStore`, `AttachmentStore` |
| **`*Reader`** | Read-only lookup (any source, including a human via UI) | `CredentialReader`, `UserInputReader`, `RecipeReader` |
| **`*Client`** | Wraps an external system we consume (process, service, API) | `ShellClient`, `BrowserClient` |

### Why these four?

Each name maps to a real, distinct communication pattern actually present
in the codebase:

- **Sink** vs **Reader** are not paired vocabularies; they address
  different shapes. Sinks come from stream/pipeline vocabulary (Flink,
  Serilog, RxJava). Readers come from IO vocabulary (`io.Reader`,
  `BufferedReader`). Mixing them is fine and standard — most real
  systems do (Spring's `*Repository` for queries vs `*EventPublisher`
  for events). What we **never** do is mix vocabularies *within* one
  shape (no `CredentialReader` *and* `RecipeFetcher` — both must be
  `*Reader`).
- **Sink** has no paired read-side suffix in our codebase because events
  only flow one way: the core emits; the shell consumes. We never have
  the shell pushing events into the core. The etymological pair of
  `*Sink` would be `*Source`, but we don't have any.
- **Client** is not a port shape; it's a category for "wraps an external
  runtime we talk to" (`ShellClient` runs commands in Docker;
  `BrowserClient` runs Playwright). Compare `RedisClient`,
  `KubernetesClient` — same pattern.

### Banned suffixes

These are **not** used in this codebase because they are vague or
duplicated above:

- `*Provider` — too vague; usually means "Reader" or "Store"
- `*Service` — too vague; almost always means "Store" or a stateful class
- `*Resolver` — academic; use `*Reader`
- `*Executor` — ambiguous (Java thread-pool vs "runs commands"); use `*Client`
- `*Sandbox` — domain noun, not a TS suffix; use `*Client`
- `*Repository` — DDD jargon overlapping with `*Store`; use `*Store`
- `*Manager`, `*Handler`, `*Helper`, `*Util` — content-free; rename to
  something that says what it does

### Adapter naming

Adapters in `packages/server/src/adapters/` are named
`<Technology><PortName>`. The port suffix is preserved exactly so the
relationship is obvious:

```ts
// Port (in packages/agent/src/ports/stores/audit-store.ts):
export interface AuditStore { ... }

// Adapter (in packages/server/src/adapters/sqlite-audit-store.ts):
export class SqliteAuditStore implements AuditStore { ... }
```

A reader sees `SqliteAuditStore` and instantly knows: SQLite-backed
implementation of `AuditStore`. The dependency direction is obvious.

## 5. State — when classes earn their existence

Plain functions are the default. A class is only justified when **all
three** of these are true:

1. The object holds mutable state that survives across calls.
2. That state has a lifecycle (construct → use → dispose).
3. There is identity (you can distinguish instance A from instance B).

Examples that earn their class status today: `Agent`, `AgentOrchestrator`,
`SqliteDb`, `MessageQueue`, `ToolFailureCircuitBreaker`,
`SqliteConversationStore`.

Examples that do **not** earn it: anything you'd be tempted to write as
`class FooHelper { static foo() {...} }`. That's a namespace, not a
class. Just export the function.

Closures (`function build(deps) { return { method: (args) => ... } }`) are
preferred over classes when there's no inheritance, no polymorphism, and
no `instanceof` involved — for example, the per-run tool factory
(`buildTools(host, run)`). They're mechanically equivalent to a class
with one constructor argument and a few methods, but lighter.

## 6. Zero ambient state

This codebase has no `AsyncLocalStorage`, no `currentRuntime()` lookup,
no module-level setters that mutate shared state, no `let` at module
scope holding cross-call data.

The reasons we don't:

- Ambient state hides dependencies. A function that reads
  `currentRuntime().mssql.databases` has an invisible parameter. The
  reader has to chase the call site to know what it touches.
- Ambient state breaks tests. Two tests that set the same global
  interfere. Concurrent tests are impossible without isolation tricks.
- Ambient state hides architectural drift. New setters get added because
  "there's already a pattern", and the dependency surface grows silently.

The cost of the alternative — threading `host` and `run` parameters
through tool boundaries — is a one-time refactor and adds a few
parameters to function signatures. The gain is permanent visibility of
every dependency. This is the same trade C programmers make: every
function takes its `Context*`.

## 7. Mechanical enforcement

These rules are checked by lint, not by code review alone:

- No `let` at module scope (allowlist for genuine boot-time singletons).
- No exported `set<Pascal>` functions whose body assigns to module
  state or to a runtime field.
- No `new AsyncLocalStorage(...)`.
- `packages/agent` may not import from `packages/server` (one-way
  dependency).
- Files in `core/` may not import anything from `shell/`, `adapters/`,
  or Node built-ins that perform I/O (`fs`, `child_process`,
  `node:net`).
- Type names ending in `Provider`, `Service`, `Resolver`, `Executor`,
  `Sandbox`, `Repository`, `Manager`, `Handler`, `Helper` are rejected.

These rules start as **warn** while the migration is in flight, then
flip to **error** at Phase 8.

## 8. What this doctrine is not

- Not a paradigm war. We mix classes and functions deliberately — state
  in classes, logic in functions. The mix is consistent because the rule
  for which-when is written down (§5).
- Not Domain-Driven Design. We borrow vocabulary (port, adapter) but not
  the DDD apparatus (aggregates, bounded contexts, ubiquitous language).
- Not Clean Architecture in the Robert Martin sense. Same intuition
  (concentric layers, dependency direction inward), simpler vocabulary.
- Not pure functional programming. We have side effects. They live in
  the shell, where they're easy to see and replace.

If a future change conflicts with this document, update the document
first, then change the code. The doctrine is the contract.
