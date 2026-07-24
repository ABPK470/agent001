# Architecture

TypeScript monorepo. One design rule:

> **Shell owns state. Core is stateless. Dependencies are always parameters.**

That rule shapes the monorepo split (platform shell vs reusable execution
packages) and, inside `agent` / `sync`, the `domain` / `core` / `runtime`
layers. Other packages follow the same rule without copying that folder
shape: `server` and `ui` are shell dialects; `connectors` is an engine +
adapters; `shared-*` are flat contracts.

---

## 1. What the rule means

- **Core** — pure functions. Anything needed is in the signature. No module-level
  mutable state, no ambient lookups, no hidden singletons.
- **Shell** — long-lived objects built once at composition (HTTP, SQLite, queues,
  sandboxes, hosts). Shell owns identity, lifecycle, and I/O.
- **Parameters** — boot state on explicit host objects; per-operation data
  passed in. Request identity is resolved at the HTTP boundary and threaded
  down — never ambient request context.

Ports name I/O contracts. Adapters implement them. Execution packages never
import the platform shell.

See [docs/doctrine.md](docs/doctrine.md) for the full contract.

---

## 2. System shape

```text
        user
          │
          ▼
         ui                             React SPA · REST + SSE
          │
          ▼
      @mia/server                       composition root · HTTP · SQLite · queue · sandbox
        │        │           │
        ▼        ▼           ▼
   @mia/agent  @mia/sync  @mia/connectors
   execution   MSSQL      cross-system
   loop        metadata   data movement
   + tools     reconcile  (Bridge)
        │        │           │
        └────────┴─────┬─────┘
                       ▼
        @mia/shared-types · @mia/shared-enums
```

**Dependency direction (one-way):**

| Package | May depend on |
| --- | --- |
| `ui` | `shared-types`, `shared-enums` (server only over HTTP) |
| `@mia/server` | `agent`, `sync`, `connectors`, `shared-*` |
| `@mia/agent` | `shared-*`, `@mia/sync` |
| `@mia/sync` | `shared-*`, `mssql` — **not** `@mia/agent` |
| `@mia/connectors` | `shared-types` — **not** agent / sync / server |
| `shared-types` | `shared-enums` |
| `shared-enums` | — |

`@mia/server` is the only package that owns infrastructure. Everything below it
is reusable and testable in isolation.

---

## 3. Ports

When a type crosses a package boundary (or a test must fake it), it is a
**port** — a contract with no implementation. Names follow communication shape:

| Suffix | Shape | Examples |
| --- | --- | --- |
| `*Sink` | Fire-and-forget event push | `SyncEventSink` |
| `*Store` | Read and write the same entity | `AttachmentStore` |
| `*Reader` | Read-only lookup | `CredentialReader`, `UserInputReader` |
| `*Client` | External system we consume | `ShellClient` |
| `*Port` / `*Provider` / `*Registry` | Named capability or lookup surface | `ConnectorPort`, `MssqlPoolProvider`, `PublishedSyncDefinitionRegistry` |

Execution packages **declare** ports. The server **provides** adapters. Agent
never imports server.

---

## 4. `@mia/agent` — execution engine

Given a goal, tools, and an LLM client, runs the model-plus-tools loop and
returns an answer. No HTTP or database ownership — all I/O arrives through
ports and the host.

| Layer | Owns |
| --- | --- |
| `domain/` | Enums, types, tenant vocabulary |
| `core/` | Pure decisions — plan, path choice, clarify, doctrine, policy, govern, recover, delegate gates |
| `runtime/` | Host, run context, goal loop, delegation drivers |
| `ports/` | Host contracts and I/O-backed service shapes |
| `tools/` | Executable capabilities bound to host + run context |
| `memory/` | Compaction, tiers, prompt budget |
| `llm/` | Model clients |
| `internal/` | Package helpers |

**Two state objects:**

- **`AgentHost`** — process lifetime: workspace, MSSQL, filesystem, shell,
  attachments, catalog, sync façade, connectors, tenant identity. Built once by
  `configureAgent`. A null capability means “not wired.”
- **`RunContext`** — per run: abort signal, memory, trace, policy, sync-op
  context. Threaded into every tool handler.

**`TenantConfig`** (business knobs: mirror schema, routing vocabulary, SQL
thresholds) is separate from `AgentHost.tenant`. Loaded once at server boot;
the documented ambient getter is intentional and narrow.

Tools are constructed with host + context already bound — not ambient
registration. Public surface: `@mia/agent` barrel only.

Detail: [packages/agent/SYSTEM.md](packages/agent/SYSTEM.md).

---

## 5. `@mia/server` — composition root

Owns HTTP, SQLite, Docker sandbox, process config, auth, queues, SSE, and
product API surfaces. Builds the agent host once, wires every adapter, and
exposes REST + SSE.

| Layer | Owns |
| --- | --- |
| `boot/` | Process life |
| `http/` | Fastify composition |
| `infra/` | Persistence, events, queue, sandbox, LLM adapters, MSSQL, effects |
| `adapters/` | Implementations of agent / sync / connectors ports |
| `runtime/` | Run orchestration, prompt assembly, tooling registry, workspace / execution |
| `api/` | Product HTTP surfaces — one capability per surface |
| `ports/` | Server-owned contracts |
| `cli/` / `internal/` | Operator entry / helpers |

API surfaces include runs, sync, connectors, platform, auth, policies,
notifications, proposer, approvals, evidence, operations, warehouse, and
related control surfaces. Domain nouns for folders — not customer brand names.

**Runs.** The orchestrator allocates a run, filters tools by role and policy,
persists the run row, enqueues work, builds a per-run host and agent, and
streams steps over SSE. Runs checkpoint; resume rebuilds environment and
continues; cancel / kill abort registered signals.

**Identity.** SQLite (`users` / `sessions`). Session resolved at the HTTP
boundary and passed explicitly downstream. Admin is a column, not a bypass of
policy. **Viewing as** (admin-only) is shell-owned: Personal routes declare
`personal.read` / `personal.write`; handlers consume `viewingAsOf(req)`.
Platform surfaces omit those preHandlers. See `docs/doctrine.md` §5b.

**Persistence.** One SQLite database (default under `MIA_DATA_DIR` /
`~/.mia`). Migrations on boot. Plans, evidence, attachments, and caches live
under the same data directory.

---

## 6. `@mia/sync` — MSSQL metadata reconciliation

Reconciles **ABI metadata** between two Microsoft SQL Server environments:
scoped, deterministic preview of row changes, then execute against a frozen
plan. MSSQL-specific by design. No dependency on `@mia/agent` — tool and host
shapes are structural; the server wires both.

| Layer | Owns |
| --- | --- |
| `domain/` | Vocabulary, plan shapes, governance types, branded ids |
| `core/` | Pure compile, eligibility, flow/action model, intent, proposer, publish rules |
| `runtime/` | Preview, execute, plan store, loaders, diff I/O, events |
| `ports/` | Host, sinks, registries, pool provider |
| `tools/` | Agent-facing sync tools |
| `adapters/` | MSSQL pools, HTTP |

**Authority chain:** Catalog (authoring in SQLite) → Publish → published
SyncDefinitions → Preview (SyncPlan + changeSet) → Execute (apply changeSet,
then post-metadata flow). Preview is read-only; execute writes the target.

Detail: [sync-system.md](sync-system.md),
[packages/sync/SYNC-MODEL.md](packages/sync/SYNC-MODEL.md),
[packages/sync/SYNC-MECHANICS.md](packages/sync/SYNC-MECHANICS.md),
[packages/sync/SYNC-PREVIEW-EXECUTE.md](packages/sync/SYNC-PREVIEW-EXECUTE.md).

---

## 7. `@mia/connectors` — Bridge

Cross-system data movement engine: read / transform / write across adapters
(MSSQL, Postgres, Oracle, Databricks, Denodo, Hive, HTTP, WebHDFS, object
storage, Aqueduct, and related formats). No HTTP or product persistence of its
own. Server owns connector config and pools; agent reaches it through a
`ConnectorPort` and the Bridge tool; UI exposes a Bridge surface.

---

## 8. Contracts — `shared-enums` & `shared-types`

Every value that crosses HTTP, SSE, or package boundaries is defined once.

- **`shared-enums`** — wire enums (run/step status, events, planner/trace kinds,
  sync, policy sources, error codes, …). `as const` + union + list + guard.
  Renaming a wire value is a breaking change.
- **`shared-types`** — DTOs and shared shapes: runs/traces, SyncPlan and
  changeSet, connectors specs, sync flow / value-source vocabulary, event
  catalog and presentation labels, SSE payloads.

---

## 9. `ui` — front end

React SPA over the backend contract: REST for commands, one SSE stream for
live updates. Zustand for client state; SSE deduplicated across tabs via
BroadcastChannel.

| Layer | Owns |
| --- | --- |
| `boot/` / `app/` | Entry and chrome |
| `client/` | Transport |
| `state/` | Client composition root |
| `widgets/` | Product surfaces (chat, runs, sync, registry, Bridge, …) |
| `components/` | Presentation-only shared UI |
| `lib/` | Pure helpers (including event projection) |
| `theme/` / `enums/` / `hooks/` | As named |

Thin client: orchestration, governance, and persistence live on the server.
UI issues commands and projects shared vocabulary — it does not invent wire
kinds or tool labels.

---

## 10. Where state may live

**Allowed:** composition-root objects; persistence; `AgentHost` / `RunContext`
(and sync host façades); host-attached caches; locals; documented ambient
business knobs loaded at boot (`TenantConfig`).

**Forbidden:** undeclared module mutable state; ambient DI (`getGlobal*` /
`setGlobal*`); hidden request context as the dependency bus.

New dependencies are parameters. That is the architecture in one instruction.
