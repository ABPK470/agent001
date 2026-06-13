# Architecture

This is a TypeScript monorepo. Every package shares one design rule and one
naming taxonomy. Read this section first — the rest of the document is just that
rule applied package by package.

---

## 1. The one rule

> **Shell owns state. Core is stateless. Dependencies are always parameters.**

This is _functional-core / imperative-shell_, applied fractally — at the
monorepo level and again inside every package.

What it means in practice:

- **Core** is pure functions. If a function needs something, that something is
  in its signature. No module-level mutable state, no globals, no ambient
  lookups, no singletons reached through the back door.
- **Shell** is the small set of long-lived, stateful objects built once at boot
  (the HTTP server, the SQLite connection, the event broadcaster, the run
  queue, the sandbox manager, the agent host). Shell owns identity, lifecycle,
  and I/O.
- **Everything flows downward through parameters.** Boot-time state lives on
  explicit host objects; per-operation data is passed in or captured in a
  closure. There is no `AsyncLocalStorage` carrying
  request state.

`scripts/lint-arch.mjs` enforces this: it bans module-level mutable state
outside allowlists, bans exported ambient setters, bans `new AsyncLocalStorage`,
and enforces cross-package import direction.

The full rationale lives in [doctrine.md](doctrine.md); the migration history is
in [P&A_refactor.md](P&A_refactor.md).

## 2. The port taxonomy

When a type crosses a package boundary (or a test needs to fake it), it becomes
a **port** — an interface with no implementation. There are exactly four
shapes, named by their communication pattern:

| Suffix | Shape | Examples |
|---|---|---|
| `*Sink` | Fire-and-forget event push, no return | `SyncEventSink`, `SseSink` |
| `*Store` | Read **and** write the same entity | `AttachmentStore`, `HandoffStore`, `ToolKnowledgeStore` |
| `*Reader` | Read-only lookup (including asking a human) | `CredentialReader`, `UserInputReader`, `TableVerdictsReader` |
| `*Client` | Wraps an external system we consume | `ShellClient`, `BrowserClient` |

The **agent** package _declares_ these ports. The **server** package _provides_
the concrete implementations (adapters). The agent never imports the server.

## 3. The system shape

```text
        user
          │
          ▼
   @mia/ui  /  @mia/ui-term         (two React SPAs, REST + SSE)
          │
          ▼
      @mia/server                   (composition root: HTTP, SQLite, queue, sandbox)
        │        │
        ▼        ▼
   @mia/agent   @mia/sync           (pure execution machinery · MSSQL data reconciliation)
        │        │
        └────┬───┘
             ▼
   @mia/shared-types · @mia/shared-enums   (the contracts everyone agrees on)
```

Dependency direction is strict and one-way:

- `ui` / `ui-term` → `shared-types` / `shared-enums` (and the server over HTTP)
- `server` → `agent`, `sync`, `shared-*`
- `agent` → `shared-*` (and a **type-only** awareness from `sync` for tool signatures)
- `sync` → `shared-*` + `mssql` (it has **no** runtime dependency on the agent)

`@mia/server` is the only package that knows about infrastructure. Everything
below it is reusable and testable in isolation.

---

## 4. `@mia/agent` — the execution engine

The brain. Given a goal, a set of tools, and an LLM client, it runs the
LLM-plus-tools loop and returns an answer. It knows nothing about HTTP or
databases — all I/O arrives through ports.

### Folder structure

```
packages/agent/src/
├── index.ts          # Public barrel — the entire supported surface
├── domain/           # Vocabulary only: types, enums, constants. No logic.
├── application/
│   ├── core/         # Pure decision logic (planning, routing, governance, recovery, …)
│   └── shell/        # Stateful machinery (the Agent loop, host & run-context factories)
├── ports/            # Interface contracts for everything external (ports.ts)
├── tools/            # ~40 executable tools, grouped by domain
├── memory/           # Context compaction, memory tiers, token budgeting
├── llm/              # LLM client implementations (OpenAI, OpenAI-compatible, Databricks)
└── internal/         # Logger, JSON, path helpers (not exported)
```

### How a run executes

`Agent` (in `application/shell/agent-cluster/`) drives the loop:

1. Build the initial messages (goal + system blocks + recalled memory).
2. **Routing first.** `attemptPlannerRouting()` (in
   `application/core/planner-routing-cluster/`) scores the goal and chooses
   _direct_ or _planner_. If the planner path succeeds, it returns immediately.
3. Otherwise enter the **tool loop**: call the LLM → run completion guards → if
   the model asked for tools, execute each one (governed, traced), feed results
   back, repeat → if the model produced text, run post-round checks (stuck
   detection, answer-stability guard) and extract the final answer.
4. Return the answer plus token usage.

Tools are **not** globally registered. They are passed to the `Agent`
constructor as an array of `ExecutableTool`s already bound to their host and
run context. Tool lookup is a plain `Map<name, tool>` built at construction.

### Boot host vs. per-run context — the two state objects

Everything stateful lives on exactly two objects, both passed by parameter:

- **`AgentHost`** — built once per process by `configureAgent({...})`. Holds
  process-lifetime capabilities: MSSQL connection registry, filesystem sandbox
  root, shell mode + client, browser sessions, attachment/credential/handoff
  ports, catalog caches, sync host, tenant config. A `null` field means "this
  capability is not wired" (e.g. a CLI with no browser).
- **`RunContext`** — built once per run by `makeRunContext({...})`. Holds
  per-run facts: the abort signal, the memory writer, the active tool-trace, the
  policy context, the current sync-op context. Threaded into every tool handler.

Tool handlers receive both as arguments. Nothing is read from a global.

### What lives in `application/core/` (pure)

| Cluster | Responsibility |
|---|---|
| `planner-cluster` | Decompose a goal into a verifiable artifact graph; generate, execute, and verify plans |
| `planner-routing-cluster` | Decide _direct vs. planner_; escalate on failure |
| `governance-cluster` | Tool-quality and execution-policy checks run before each call |
| `recovery-cluster` | Retry policy, budget extension, circuit-breaker on repeated tool failure |
| `clarify-cluster` | Detect unresolved ambiguity in the goal and emit a clarification request |
| `doctrine-cluster` | Executable MSSQL query rules (big-view budget, temp-table naming, wide-union policy) |

### What lives in `application/shell/` (stateful)

| Cluster | Responsibility |
|---|---|
| `agent-cluster` | The `Agent` class — orchestrates the whole loop |
| `loop-cluster` | Iteration mechanics: per-tool execution, completion guards, post-round checks |
| `runtime-cluster` | `configureAgent()` / `makeRunContext()` — the host and context factories |
| `delegation-cluster` | Validates and routes work to child agents; enforces depth limits |

### Supporting subsystems

- **`tools/`** — filesystem, shell, MSSQL (query/profile/inspect/relationships),
  browser automation (`browse_web`, auto-login, human handoff, `browser_check`),
  web/catalog search, delegation, sync wrappers, attachments, and
  human-in-the-loop (`ask_user`, `note`, `recall`).
- **`memory/`** — multi-turn compaction (summarize older turns), working /
  episodic / semantic tiers, and a prompt budget that prioritizes sections to
  fit the model's context window.
- **`llm/`** — pluggable clients (OpenAI API, OpenAI-compatible forwarder for
  local models, native Databricks), each handling streaming, tool calls, and
  token accounting.
- **`ports/ports.ts`** — every external contract the agent depends on, named by
  the four-suffix taxonomy above.

---

## 5. `@mia/server` — the composition root

The body. It is the only package that touches HTTP, SQLite, Docker, and process
config. It builds the agent host once, wires every concrete adapter, persists
state, and exposes the REST + SSE API.

### Folder structure

```
packages/server/src/
├── index.ts          # main(): the boot sequence; builds everything and listens
├── bootstrap/        # Ordered startup helpers (config, llm, sync, workspace)
├── features/         # ~24 vertical feature modules (the bulk of the app)
├── platform/         # Cross-feature subsystems (persistence, events, queue, …)
├── ports/            # Server-side ports (orchestration, channels, clarifications)
├── crypto/           # Signing / evidence primitives
├── cli/              # Standalone CLI entry points (e.g. entity-registry export)
└── shared/           # Errors, HTTP helpers, shared enums/types/utils
```

### The boot sequence (`index.ts`)

Startup is deterministic and observable — each step logs. In order: load `.env`
→ open SQLite, run pending migrations, and seed defaults → resolve the agent workspace → configure the Docker sandbox (falling
back to host execution if Docker is absent) → set up MSSQL connections → load
sync environments → **build the boot `AgentHost` via `configureAgent(...)`**
(wiring sync sinks, catalog registry, shell/browser adapters) → seed default
policies → build the LLM client and schema catalogs → start the proposer
scheduler → wire the notification dispatcher → construct the
`AgentOrchestrator` → initialise the message queue and channel routers → build
the Fastify app and register all feature routes → open the SSE endpoint →
recover stale runs from prior crashes → listen on `:3102` → register graceful
shutdown.

### The feature convention

Each folder under `features/` is a self-contained vertical with the same
internal layering and a single public barrel:

```
features/<name>/
├── routes.ts       # Transport — Fastify handlers: parse request, call application, serialize
├── application/    # Business logic — mostly pure, calls persistence/domain
├── runtime/        # Stateful per-feature context (sessions, caches, providers)
├── transport/      # Additional route groups when one file isn't enough
├── domain/         # Feature-local types and enums
└── index.ts        # The feature's public surface; external code imports only this
```

The ~24 features include `runs`, `agents`, `auth`, `browser`, `sync`,
`notifications`, `policies`, `attachments`, `memory`, `llm`, `usage`, `admin`,
and the F1 reconciliation set (`proposer`, `approvals`, `evidence`, `metrics`).

### The `runs` feature — how a run actually runs

This is the core of the server. `AgentOrchestrator`
(`features/runs/orchestrator.ts`) owns the run lifecycle:

1. **`startRun()`** — allocate a run id, build and role-filter the tool set,
   load policy rules, persist a run row, broadcast `RunQueued`, and enqueue the
   work on the `RunQueue`.
2. **`executeRun()`** — the queue worker calls
   `prepareExecutionEnvironment()`, which assembles everything a run needs:
   a per-run workspace, execution state and persistence, event wiring, a
   **per-run `AgentHost`**, policy-governed tools, a delegate context, and the
   system prompt. It then constructs the run's `Agent` and calls `agent.run()`.
3. **Streaming** — every step and tool call is broadcast over SSE and written
   to the trace tables in real time.
4. **Resume / cancel / kill** — runs checkpoint, so `resumeRun()` rebuilds the
   environment and continues from the last checkpoint; `cancelRun()` aborts the
   controller; a single tool call can be killed via its registered abort signal.

### The `platform/` layer

| Subsystem | Responsibility |
|---|---|
| `persistence/` | The SQLite layer (better-sqlite3, WAL): all tables, queries, numbered migrations (`persistence/migrations/`), attachments, memory, evidence. |
| `events/` | The `EventBroadcaster` — the single SSE transport. Per-client identity, run-ownership filtering, event-log persistence, webhook drains, heartbeats. |
| `queue/` | The `RunQueue` (priority, slot-limited parallelism) and the `AgentBus` (persistence-backed inter-run message buffer). |
| `sandbox/` | Docker-based isolated shell and browser execution, with a host fallback when Docker is unavailable. |
| `llm/` | The LLM adapter registry (`copilot-chat`, `databricks`) and the completion adapter the proposer uses. |
| `mssql/` | Parses `MSSQL_DATABASES`, builds a pooled connection and schema catalog per database. |
| `effects/` | Transactional tracking of run side-effects with rollback. |

### Adapters — providing the agent's ports

The server implements every port the agent declares and injects the
implementations through `configureAgent()` and `createPerRunHost()`. For
example: `ShellClient`/`BrowserClient` delegate to the sandbox; the browser
context/credential/handoff ports are backed by SQLite stores; `AttachmentStore`
wraps the attachment repository; the sync sinks broadcast over SSE and persist
plan previews.

### Identity & persistence model

Persistence is a single SQLite database (default `~/.mia/mia.db`, override with
`MIA_DATA_DIR`), migrated automatically on boot. Identity is two tables —
`users` (keyed by `upn`) and `sessions` (keyed by `sid`). Identity is resolved
at the HTTP boundary, decorated onto `req.session`, and **passed explicitly**
downstream — never read from an ambient store. Admin is the `users.is_admin`
column; non-admin sessions receive a safe, reduced tool set.

---

## 6. `@mia/sync` — the MSSQL data-reconciliation engine

An independent engine that reconciles **data between two Microsoft SQL Server
databases**: it computes a deterministic plan to make a target database's rows
match a source's, then applies it. It is **MSSQL-specific by design** — the
diff algorithm is hand-written T-SQL (`HASHBYTES`, `CONCAT_WS`,
`INFORMATION_SCHEMA`, `MERGE`, SQL Server `CONVERT` style codes) and the
domain code passes the `mssql` driver's own `ConnectionPool` type directly, so
there is no SQL-dialect abstraction to swap. "SQL" here means SQL Server, not
"any RDBMS." It has **no runtime dependency on the agent** — only a type-only
import for tool signatures.

### Folder structure

```
packages/sync/src/
├── index.ts          # Public API barrel
├── domain/           # Pure reconciliation concepts (no I/O)
│   ├── diff-engine/  # Content-hash row comparison
│   ├── entity-registry/, governance/, recipes.ts, environments.ts, …
├── application/
│   ├── core/         # Pure proposer: rank & annotate conflicts
│   └── shell/        # Stateful orchestration: preview, execute, apply, plan store, sinks
├── adapters/         # MSSQL connection/pool configuration
└── ports/            # Host, event sink, run sink interfaces
```

### The flow

1. **Preview** (`application/shell/orchestrator/preview.ts`) — for each table,
   the **diff-engine** computes a row-level `HASHBYTES('SHA2_256', …)` over
   canonicalized column values on both source and target, classifying every row
   as INSERT / UPDATE / DELETE. Determinism is enforced with fixed session
   settings and explicit casting; volatile columns (`validFrom`, `validTo`,
   identity PKs, …) are excluded. The result is a `SyncPlan`.
2. **Propose** (`application/core/proposer/`) — pure ranking and annotation
   passes score and enrich conflicts with resolution metadata.
3. **Execute** (`application/shell/orchestrator/execute.ts`) — applies the plan
   (MERGE for upserts, controlled DELETE loops), toggles FK constraints,
   probes triggers and emits archive records, and streams per-table progress.
4. **Safety rails** — drift revalidation before execution, freeze-window
   governance that blocks operations during maintenance windows, and catalog
   drift policies.

The agent reaches this engine through three tools — `compare_catalogs`,
`sync_preview`, `sync_execute` — exposed from `application/shell/tools.ts`.

---

## 7. `@mia/shared-enums` & `@mia/shared-types` — the contracts

Every value that crosses an HTTP, SSE, or WebSocket boundary is defined exactly
once here, so the agent, server, and both UIs cannot drift apart.

- **`shared-enums`** — the wire enums: run/step status, event types, planner
  trace kinds, delegation outcomes, sync statuses, policy sources. Each is an
  `as const` object plus a derived union plus a runtime list plus a narrow
  guard. Wire values are immutable; renaming one is a breaking change by
  construction.
- **`shared-types`** — the DTOs: `Run`, `RunDetail`, `Step`, `TraceEntry` (a
  discriminated union of every trace event), `WorkspaceDiff`, the full `Sync*`
  family, the `SavedLayout` / widget types, and the `SseEvent` union. All enum
  references come from `shared-enums`, so a rename propagates automatically.

---

## 8. `@mia/ui` & `@mia/ui-term` — the front ends

Two independent React 18 + Vite single-page apps that speak the same backend
contract (REST for commands, a single SSE stream for live updates). State is
Zustand; the SSE client deduplicates across browser tabs via `BroadcastChannel`
and auto-reconnects.

| | `@mia/ui` (dashboard) | `@mia/ui-term` (terminal) |
|---|---|---|
| Surface | Draggable grid of widgets: chat, live trace, audit, policies, sync, usage | Two fixed panes — run transcript + unified ops log — driven by keybinds and a slash-command palette |
| Stack | React + Tailwind + Zustand + force-graph / three.js + react-grid-layout | React + Tailwind + Zustand (lean, no graph deps) |
| Dev port | `5179` | `5180` |
| Backend | identical REST + `/api/events/stream` SSE; Vite proxies `/api` and `/ws` to `:3102` | identical |

Both are thin clients: all orchestration, governance, and persistence live in
the server. The UI only renders state and issues commands.

---

## 9. Where state is allowed to live

By doctrine, state exists in only a few sanctioned places:

- the Fastify app and other long-lived shell objects,
- the SQLite connection and other adapter instances,
- the `AgentHost` (boot) and `RunContext` (per-run),
- explicit caches attached to the host (e.g. `host.sync.plans`,
  `host.catalog`),
- and per-call local variables and closures.

State is **never** hidden behind an ambient runtime lookup. If you are adding a
new dependency, thread it as a parameter — that is the whole architecture in one
instruction.

### Shortest orientation path

1. [doctrine.md](doctrine.md) — the rule, in full.
2. [packages/agent/src/index.ts](packages/agent/src/index.ts) — the agent's public surface.
3. [packages/server/src/index.ts](packages/server/src/index.ts) — the boot sequence.
4. [packages/sync/src/index.ts](packages/sync/src/index.ts) — the reconciliation surface.
