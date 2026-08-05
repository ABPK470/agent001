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

**Visibility dialect (one):** `sameUpn` (`internal/upn`) + `canAccessOwned` / `canAccessRun` / `canAccessThread` for owned rows; `eventMatchesViewingAs` (`infra/events`) for live SSE and historical events. No per-surface UPN compares. No `viewerUpn` synonym.

**Owner (UI):** chrome store (`lib/viewing-as`, including `attachViewingAsQuery`) + fetch headers in `client`. App runs one Personal scope transition on Me / Viewing as change. Widgets may read `isViewingAsOther` for quiet chrome only. Do not pass `userId` into widgets.

**Transport:** `X-Viewing-As` on fetch; `?viewingAs=` via `attachViewingAsQuery` for EventSource. Omit when Me.

**Laws:** Personal routes **declare** `personal.read` or `personal.write` at registration. Lists/gets/SSE filter to Viewing as UPN. Personal writes only when Me (`personal.write`). Platform routes omit those preHandlers and never read Viewing as (e.g. Sync Admin `/api/sync/runs` is admin-only; Env Sync uses `/api/sync/history`). Admin keeps their own dashboard layout when Viewing as someone else.

**Do not call it** workspace subject, inspect, fleet, impersonation, or context switcher.

---

## 5c. Platform store vs domain connectors vs warehouse Sync

Three durability / I/O concerns. They share **sql-kit helpers** (quoting,
literals, error taxonomy) — never one connection, never one ORM over both
worlds, never document/NoSQL stores as platform life.

### Platform store (Mia’s own life)

Product durability: users, sessions, threads, runs, events, policies, entity
registry, sync *definitions*/catalog tip, approvals, memory, notifications,
channels, effects. Owned by server persistence ports + repository functions.

**RDBMS is pluggable — one platform store per process:** adapters under
`packages/server/src/infra/persistence/adapters/{sqlite,mssql,postgres}/**`.
Product targets: **`sqlite` (default — local and current hosted)**; **`mssql`**
and **`postgres`** are first-class peers when a deploy chooses them. One of
`sqlite | mssql | postgres` per process. Selection is config
(`MIA_PLATFORM_STORE` + connection), not a rewrite of API/services. Never run
two platform stores together; never use warehouse Sync / Bridge connector pools
for platform life.

Target contract: **async** repository ports; `PlatformStore.transactionAsync`
is the multi-dialect shape. The SQLite adapter may still expose a sync
`transaction` bridge for local paths.

**Memory keyword search** is dialect-owned via `MemorySearchPort` (same
platform DB — not a search sidecar):

- **Tier 1 (sqlite):** FTS5 BM25 on `memory_entries_fts`.
- **Tier 1 (postgres):** `tsvector` / `plainto_tsquery('simple')` + `ts_rank`
  on `memory_entries.search_vector` (trigger-maintained; `simple` regconfig
  for keyword/code/id parity with FTS5).
- **Tier 2 (mssql):** explicit degraded token/recency filter on
  `memory_entries` — intentional product trade-off, not silent FTS parity.
  SQL Server Full-Text (`CONTAINS`) is a future adapter on the same port.

### Warehouse Sync (customer From/To)

Diff, fingerprint, apply/upsert/delete, SCD2 stamps, catalog drift, FK probes
run against the **customer** warehouse through `WarehouseDialect` plugins
(`packages/sync/src/adapters/{mssql,postgres}/dialect/**`). Pure changeSet /
plan core stays dialect-free. Eligibility: connector kind ∈ `{mssql, postgres}`
(enabled). Capabilities such as `mssql_procedure` / Mymi `usp*` stay
**MSSQL-only** — Postgres envs refuse or use `custom_sql` / http; no fake
parity.

### Domain connectors / Bridge (row-move)

Warehouse pools for Bridge `moveData`, agent `query_*` tools, and other
execution I/O. Already multi-dialect. **Never** share the platform store
connection. Sync apply does **not** call Bridge `moveData` (bulk transfer ≠
entity reconcile). Optional thin reuse of sql-kit quoting / identity helpers
only — no wholesale connectors rewrite.

### Laws

- Callers use repository functions (via public persistence barrels) or named
  ports — never `getDb()` / `better-sqlite3` / driver clients outside the owning
  adapter tree (`infra/persistence/adapters/**` for platform;
  `packages/sync/src/adapters/**` for warehouse dialect SQL after extract).
- `getDb` is not re-exported from public barrels. Tests and boot may import
  connection hooks from `adapters/sqlite/index.js` (and peer adapters when
  added).
- **Zero dialect SQL** (MERGE, HASHBYTES, `sys.*`, identity-insert, vendor
  temp tables, …) outside adapters — enforced by `lint:arch`. Sync
  `domain/` / `ports/` stay pure. Warehouse SQL for hash / MERGE / PK / target
  columns lives under `packages/sync/src/adapters/mssql/dialect/**` via
  `WarehouseDialect`; remaining runtime owners (catalog-drift, search NOLOCK,
  conflict probes) extract next.
- Platform store and warehouse Sync **never** share a pool or transaction.
- Scale ports sit beside the store, not inside SQL call sites: **EventStore**,
  **ResourceScheduler** / run queue, **ConnectionBudget** (warehouse pool
  caps), **LlmThrottle**, **PlatformStore**.
- Shared kit: `@mia/sql-kit` — quoting, literals, transient-error helpers.
  Sync MERGE semantics and platform repos do **not** share one query builder.

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

`allowedExtraDirs` (lint-arch) may name non-layer trees such as sync
`test-support/` or shell/UI `local-harness/`. Those are disposable local
helpers — never product seams, never enabled by `NODE_ENV` alone, never
hosted. Prefer deleting the folder over growing platform surface.

### UI

**Visual / interaction dialect (locked):** structure is two-ink (paper + ink
borders / select-fill). **Brand accent** is the shared purple (`--accent`,
same family in light and dark) for logo live mark, Viewing as, Ask-user
interrupt, and brand links — never for “selected,” never for Trace category
leads (TOOLS / CONTEXT stay muted peers). **Go-to** (`CONTROL_READY` /
`.mia-control--ready`) = solid **ink** fill for the one next step (Preview →
Execute, Save when dirty, Publish when armed) — navigates the eye without
becoming “selected.”

**Status dialect (two layers, shared everywhere):**

| Layer | What | Treatment |
|---|---|---|
| **Status mark** | Any run / operation / user-state indicator | One `StatusMark` + `statusDotKind` — ok = hollow ring, fail = filled, live = pulse ring, skip = dashed (skipped / cancelled / stopped), muted = soft fill. Shape over traffic chroma on light (`packages/ui/src/components/StatusMark.tsx`). Same glyph for the same status string in Pipelines, Threads, Active Users, Sync. |
| **Status callout** | Failed / warn / cancel / success / running **payloads** (message boxes, banners, Event Stream error rows, Trace phase events, Chat **terminal** error / cancelled bodies, toasts, danger-zone cards) | Theme-split `--status-callout-*` soft + border; muted regular text. **Light:** chroma wash on paper (same family as policy softs). **Dark only — Factory Reset dialect:** quiet `--overlay-2` panel + ~20% chroma hairline border (e.g. `border-error/20`); body stays muted theme ink; icons/buttons may use muted `--error` accents. Never loud soft slabs on dark. Shared helpers in `packages/ui/src/lib/status-callout.ts` / `.mia-callout--*`. Policy-effect softs (`--policy-*-soft`) stay separate for ALLOW/DENY cards. Never plain paper + colored text alone. |

Chat **orchestrator process beats** (`Subagent ·`, `Check · needs work`,
`Repair ·`, `Checked work`) are mid-loop gates — muted activity chrome like
other step headers, not status callouts. Soft chroma is reserved for true
terminals (run failed / cancelled / escalate). Chat / Trace **activity
headers** stay muted ink chrome (Cursor dialect) — narrative labels are not
status marks; never paint the whole “Subagent · … · failed” row red.

**Chat tool I/O (locked):** dark reference dialect — code boxed, results bare text.
1. **Input** — `CodeBlock` for code (SQL / Shell + Copy); prose uses labeled
   **Input** pane. Uses the column width (`width: 100%`); short answer fences
   may still `w-fit`.
2. **Output** — raw monospace text on the sheet: `(N rows)`, header,
   `----+----` rule, then rows. No Output chrome box, no DataTable.
3. **Error** — status callout (theme-split soft wash).

Never leave code inputs unframed; never frame success results like code.

On **light**, structural status + syntax tokens
(`--success|warning|error|info`, `--dt-*`) resolve to **ink** for marks /
datatype; callout chroma lives on **policy / callout-info** tokens. Soft
structural washes stay `--overlay-2`. **Exception — diffs:** content change
panes (`CatalogJsonDiff`, env-sync sample/row diffs, workspace file change
markers) use dedicated `--diff-*` tokens: pane surface =`#f6f4f1` (same as
workspace field / top bar, not widget `--paper`); added = clear green,
removed = clear red, unchanged = ink text. **Exception — policy effects:**
allow / deny / require-approval use `--policy-*` chroma (and the same wash
on Selector Rules cards) so outcomes read in ~300ms. Dark keeps meaning
hues (diff/policy tokens alias status). Orient in ~300ms with
three signals only (`packages/ui/src/lib/selection.ts`): **place** = quiet `--select-fill` aliased to `--overlay-2` on light (same wash as Active Users KPI interiors; layout sheets = inset pill with air in the
chrome row; section tabs = rounded shade); list rows same wash with
`--list-row-radius` (Threads / Trace / Event Stream / rails) — never
underline ticks or left-rule bars; light `--hover-fill` = `--overlay-1`;
**mode** = `--select-fill` shade + weight (`SELECT_*` inside a framed track —
never inverted pills or screaming outline frames; never bare on filter chips);
**control** = keep the frame, fill `--hover-fill` / `--select-fill` on
hover/press (FilterSheet choice grids, free-floating filter nav — never
border-only hover, never transparent-border “plain text” idle).
Tree elbows are hierarchy only — never selection. Dirty / menu-open / Sheet
are controls, not mode. Surfaces own one perimeter; insides use dividers and
controls — never nested grey plates. Top bar, tiles, modals, and filter sheets
share that language. Review widgets (Event Stream, Pipelines, Trace) share one
`WidgetToolbar` strip: leading | search | trailing (expand/collapse +
filter/export sit in trailing — never leading chip rows). Filter *choices*
may differ per widget; filter chrome, search seam, icon buttons, and chips
must not. Content dialect is shared with Threads hierarchy: one curved tree
via `components/ReviewTree.tsx`
(`.review-tree` / `.review-tree__item` — same geometry as Threads runs) for
list nesting only — never inside `JsonViewer` (use `.review-branch-pad`).
Prose under a soft scope (Prompt / reply) uses `.trace-scope-payload` (label
column) — never the nested-peer gutter. Direct `ReviewTreeItem` children
only; bare siblings / sibling nests break the stem. Nest flush with the
parent row — stem under `.review-chevron-slot` / `--review-tree-x` (never a
second `pl-*` before the tree). Seams earn their keep: toolbar closes
controls; meta uses space (no second chrome rule); open outline headers
drop under-lines (elbows own descent); collapsed peers keep a quiet
hairline. One meta size (`--review-meta-size`), one day/section cap
(`.review-group-label` / `--review-group-size` — quieter than body;
sticky fill via `.review-group-cap` / `--section-cap-bg` — light = paper,
dark = lifted wash on the tile, never a sunk `--panel` plate), one
chevron (13px, rotate-90), one control height (`--control-h` for search /
segments / icon buttons), one JSON/payload surface. Pipelines shares toolbar
expand/collapse with Trace (`ReviewTreeFoldToggle` in trailing toolbar). Trace sticky pin stays.

**Spaces, Summon, keyboard (operator console):** Product **Spaces** (Agent /
Observe / Reconcile / Bridge) are curated job landings — not DIY-named
sheets as the primary path. **Summon** (⌘/Ctrl+K) peeks a widget or Calls a
Space; Keep in Space is explicit. Trace (and later Pipelines) own **pane
focus** with one Esc ladder (overlay → filter → pane → zen → maximize).
Shell chords: Call Space (⌘/Ctrl+1–4), tile focus (⌘/Ctrl+⌥+arrows), M
maximize, Z zen, ⌘/Ctrl+W close tile, `?` keymap. See `lib/spaces.ts`,
`lib/keymap/`, `app/workspace/SummonPalette.tsx`.

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
