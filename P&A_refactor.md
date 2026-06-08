# Plan: Refactor to Functional Core / Imperative Shell — zero ambient state

## Architectural shape (the load-bearing concept)

Core/shell is fractal. It applies at two levels:

1. System level — `@mia/agent` is the core; `@mia/server` is the shell.
2. Inside each package — every package has its own `core/` (pure functions),
   `shell/` (stateful + I/O), and (for the agent) `ports/` (interfaces only).
   The server has `adapters/` instead of `ports/` — concrete implementations
   of the agent's ports.

The one rule for "is this core or shell?":
> Core-ness is determined by purity, not by package location. A pure helper
> inside the server package is still core. A stateful driver inside the agent
> package is still shell.

Folder convention (enforced by Phase 0 lint):

```
packages/agent/src/
  core/        <- pure functions only
  shell/       <- stateful, I/O-adjacent (Agent class, host, llm, tools)
  ports/       <- interfaces only (sinks/, stores/, readers/, clients/)

packages/server/src/
  core/        <- pure orchestration & policy rules
  shell/       <- Fastify, SQLite, SSE, channels
  adapters/    <- implementations of @mia/agent ports
```

## Port-naming taxonomy (4 suffixes, all industry-standard)

| Suffix | Communication shape | Examples |
|---|---|---|
| `*Sink` | Event push: fire-and-forget, no return value | `SyncEventSink`, `SseSink` |
| `*Store` | Read + write same entity (persistence) | `AuditStore`, `SyncPlanStore`, `AttachmentStore` |
| `*Reader` | Read-only lookup, any source incl. a human | `CredentialReader`, `UserInputReader`, `RecipeReader` |
| `*Client` | Wraps an external system we connect to as a consumer | `ShellClient`, `BrowserClient`, `SseClient` |

Vocabulary rule: don't mix vocabularies within one shape (no
`CredentialReader` and `RecipeFetcher`). Different shapes use different
vocabularies on purpose (Reader for queries, Sink for events) — this is
standard practice.

No `*Provider`, no `*Service`, no `*Resolver`, no `*Executor`, no `*Sandbox`,
no `*Prompter` — all replaced by the four above or by `*Client`.

## Rename map (applied during Phase 4–5)

| Today | Tomorrow |
|---|---|
| `SyncEventSink` | `SyncEventSink` |
| `SseSink` | `SseSink` |
| `SyncRunSink` (events half) | `SyncRunSink` (write-only events only) |
| `SyncRunSink` (savePlan/loadPlan half) | `SyncPlanStore` |
| `BrowserContextProvider` | `BrowserContextReader` |
| `BrowserCredentialProvider` | `CredentialReader` |
| `BrowserHandoffProvider` | `HandoffStore` |
| `AttachmentService` | `AttachmentStore` |
| `AskUserResolver` | `UserInputReader` |
| `ShellExecutor` | `ShellClient` |
| `BrowserCheckExecutor` | `BrowserClient` |
| `MemoryRunRepository` | `RunStore` |
| `AuditService` | `AuditStore` |

## P&A — what we are and aren't doing

- We are doing Ports & Adapters: protect the core from infrastructure churn,
  enforce dependency direction.
- We are not doing runtime Strategy swapping. One port to one production
  adapter is the norm.
- A type becomes a port only when it crosses the core/shell package boundary,
  or tests need to fake it. Otherwise it's a plain function.

## TL;DR

Eliminate all ambient state from this codebase. Every dependency arrives as an
explicit parameter — the same way a C codebase threads a `Context*` through
every function. State lives only in a small number of long-lived shell objects
constructed at boot. Everything else is pure functions or closures that capture
their dependencies at construction time.

Target end state:

- 0 `AsyncLocalStorage` instances (down from 6)
- 0 `setXxx` module-level mutators (down from 29)
- 0 `currentRuntime()` calls (down from about 150)
- 0 module-level `let` bindings that hold cross-call state
- 1 sanctioned word for each architectural role
- 1 entry point that wires the host: `configureAgent({...}) -> AgentHost`
- `@mia/sync` extracted to its own package, enforced by the npm boundary

## The doctrine (written down, lint-enforced)

The single rule that, applied consistently, makes everything else fall out:

> Shell owns state; core is stateless; dependencies are always parameters.

Specifics:

1. Shell (imperative, classes) owns identity, lifecycle, I/O, mutable state.
   Built at boot. Examples that earn their class status: `AgentDriver`,
   `SqliteDb`, `SseBroadcaster`, `MessageQueue`, `SandboxManager`,
   `ToolFailureCircuitBreaker`.
2. Core (functional, functions and closure factories) has no module-level
   state, no setters, no ALS. If a function needs X, X is in its signature.
3. Names follow role, not author preference.

## Target architecture (one screen)

```
                        +------------------------------------+
   BOOT (once):         | configureAgent({                  |
                        |   sinks, stores, ports, executors,|
                        |   paths, mssqlConfigs             |
                        | }) -> AgentHost  (frozen)         |
                        +--------------+---------------------+
                                       |
   PER RUN (many):                     v
                  +------------------------------------+
                  | runContext = makeRunContext({      |
                  |   runId, upn, workspaceRoot,       |
                  |   signal, sessionId                |
                  | })                                 |
                  +--------------+---------------------+
                                 v
                  +------------------------------------+
                  | tools = buildTools(host, runContext)|
                  | agent.run(goal, tools)             |
                  +------------------------------------+
                                 |
   PER TOOL CALL (many):         v
                  tool.execute(jsonArgs) -- closure already has host+run
                  passes them to pure helpers in core/
```

No `currentRuntime()`. No setters. No ALS. Dependencies flow downward through
parameters only.

## Steps (each is an independently shippable PR or PR-set)

### Phase 0 — Write the rule down & lint it (1 PR)
- Add `docs/doctrine.md` with the two-page rule above.
- Add eslint rules: ban `let` at module scope, ban exported `set<Pascal>`
  functions whose body assigns to module/runtime state, ban
  `new AsyncLocalStorage`.
- Rules start as warn for the existing code, error for new code in migrated
  paths. Move to global error after Phase 6.

### Phase 1 — Inventory document (1 PR, no code change)
- Produce `docs/runtime-inventory.md`: every `currentRuntime()` read, every
  `setXxx`, every ALS instance, classified by target layer and blast radius.
- This is the table we argue over once. Sign-off here gates the rest.

### Phase 2 — Introduce the new types, no migrations yet (1 PR)
- New file `packages/agent/src/host.ts`.
- New file `packages/agent/src/run-context.ts`.
- New file `packages/agent/src/tools/build-tools.ts`.
- Nothing else changes. Both worlds coexist.

### Phase 3 — Pilot: convert one tool end-to-end (1 PR)
- Pick `read_file`.
- Rewrite as `(host: AgentHost, run: RunContext, args: ReadFileArgs) => Promise<string>`.
- Register it via `buildTools` in the agent loop, alongside the legacy registry.
- Delete `setBasePath` and the `currentRuntime().filesystem.basePath` reads in
  this one file.

### Phase 4 — Migrate tools cluster by cluster (7 PRs, smallest first)
1. attachments
2. askUser
3. browse-web ports
4. search-files
5. shell + browser-check executors
6. mssql
7. catalog + tool-knowledge + memory + tableVerdicts

Acceptance per cluster: zero `currentRuntime()` references in the migrated
files; cluster setters deleted; tests still pass.

### Phase 5 — Migrate sync subsystem in place (3 PRs)
- 5a: Split `SyncRunSink` into `SyncRunSink` and `SyncPlanStore`.
- 5b: Convert `previewSync` / `executeSync` to take `(host, run, input)`.
- 5c: Eliminate `syncOpContext` ALS and thread explicit telemetry callbacks.

### Phase 6 — Demolish the god object (1 PR)
- Delete the parent-inheritance constructor logic.
- Delete the static `#als` and `currentRuntime()` export.
- Delete the `setXxx` re-exports from `lib.ts`.
- Rename surviving file to `run-context.ts` if not already.
- Migrate the remaining ALS instances to explicit parameters.

After this PR: zero `AsyncLocalStorage` instances in the codebase.

### Phase 7 — Extract `@mia/sync` as a sibling package (1 PR)
- New workspace `packages/sync` with its own `package.json`.
- Move the agent-local sync implementation into `packages/sync/src/**`.
- Move `packages/agent/src/tools/sync-tools.ts` to `packages/sync/src/tools.ts`.
- `@mia/agent` adds `@mia/sync` as a dependency and re-exports `syncTools`.

### Phase 8 — Enforce, document, celebrate (1 PR)
- Flip the Phase 0 eslint rules from warn to error globally.
- Rewrite `SYSTEM.md` and `ARCHITECTURE.md` to describe the new shape.
- Add `docs/doctrine.md` to the top of `CONTRIBUTING.md`.

### Phase 9 (optional, later) — Extract `@mia/mssql-tools`
Same exercise as Phase 7. Leaves `@mia/agent` as the loop + planner + recovery
+ delegation + governance + llm clients + domain types.
