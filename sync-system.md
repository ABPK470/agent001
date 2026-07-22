# ABI Environment Sync — System Reference

This document describes how cross-environment metadata synchronization works in **agent001**, as implemented in source code. It is written for operators, integrators, and developers who need to understand prerequisites, preview, execution, governance, and per-entity behaviour without reading the entire `@mia/sync` package.

**Primary code locations**

| Area | Path |
|------|------|
| Sync package | `packages/sync/` |
| Orchestrator (preview / execute) | `packages/sync/src/service/shell/orchestrator/` |
| Domain (recipes, diff, environments) | `packages/sync/src/domain/` |
| Agent tools | `packages/sync/src/service/shell/tools.ts` |
| Server REST routes | `packages/server/src/api/sync/routes.ts` |
| Definition publish / compile | `packages/server/src/api/sync/service/definitions.ts` |
| Published runtime bundle | `sync-definitions/published/definitions.bundle.json` |
| Environment config (optional file) | `deploy/sync/sync-environments.json` |
| Flow templates | `deploy/sync/artifacts/flow-templates.json` |
| Authored entity seeds | `deploy/sync/artifacts/entities/*.json` |

---

## Table of contents

1. [Concepts and vocabulary](#1-concepts-and-vocabulary)
2. [Architecture overview](#2-architecture-overview)
3. [Prerequisites — what must exist before preview](#3-prerequisites--what-must-exist-before-preview)
4. [The entity registry and published definitions](#4-the-entity-registry-and-published-definitions)
5. [Sync recipes and table closure](#5-sync-recipes-and-table-closure)
6. [Environments registry](#6-environments-registry)
7. [MSSQL connectivity](#7-mssql-connectivity)
8. [Preview — end-to-end process](#8-preview--end-to-end-process)
9. [The SyncPlan artifact](#9-the-syncplan-artifact)
10. [Diff engine — how changes are detected](#10-diff-engine--how-changes-are-detected)
11. [Conflicts and scope misattribution](#11-conflicts-and-scope-misattribution)
12. [Optional tables](#12-optional-tables)
13. [Execute — end-to-end process](#13-execute--end-to-end-process)
14. [Metadata sync transaction](#14-metadata-sync-transaction)
15. [Post-metadata pipeline](#15-post-metadata-pipeline)
16. [Per-entity-type reference](#16-per-entity-type-reference)
17. [Agent tools and chat integration](#17-agent-tools-and-chat-integration)
18. [REST API surface](#18-rest-api-surface)
19. [Governance, safety rails, and approvals](#19-governance-safety-rails-and-approvals)
20. [Events, persistence, and audit](#20-events-persistence-and-audit)
21. [Configuration reference](#21-configuration-reference)
22. [Operator workflows](#22-operator-workflows)

---

## 1. Concepts and vocabulary

### Entity

An **entity** is one logical metadata object in the MyMI ABI model — for example a **Contract**, **Dataset**, **Rule**, **Pipeline**, **Gate meta table**, or **Content** item.

In code, an entity is identified by:

| Field | Meaning | Example |
|-------|---------|---------|
| `entityType` | Published definition id | `contract`, `gateMetadata` |
| `entityId` | Primary key of the **root table** row in the **source** environment | `2545` → `gate.MetaTable.tableId` |

The **root table** is the canonical row for that entity type (e.g. `core.Contract`, `gate.MetaTable`). All dependent tables are reached via foreign-key closure and scoped predicates.

Users may refer to entities by **display name** (e.g. `ACSRawTest`) or by **numeric id**. The system resolves names via `search_sync_entities` / `searchEntities()` against the root table's label column (`name`, `title`, etc.).

### Environment

An **environment** is a named MSSQL connection with sync policy: source/target role, allowed sync directions, service URLs for callbacks, and access control. Examples: `uat`, `dev`, `prod`.

Sync always moves metadata **from a source environment to a target environment** (`source → target`). Source and target must be different; direction must be allowed by policy.

### Recipe

A **recipe** (`SyncRecipe`) is the runtime projection of a published definition: root table, key/label columns, ordered table list, per-table scope predicates, execution order, archive tables, discrepancies, and post-metadata action hints.

Recipes are **not** hand-edited at preview time. They come from the published bundle via `definitionToSyncRecipe()`.

### Published definition

A **published definition** (`PublishedSyncDefinition`) is the immutable, versioned contract compiled at **publish** time and stored in `definitions.bundle.json`. Preview and execute read **only** this bundle at runtime (cached by mtime).

### SyncPlan

A **SyncPlan** is the durable output of **preview**: per-table insert/update/delete/unchanged/conflict counts, samples, dependency graph, frozen execution contract, governance decision, and decision log. Execute references the plan by `planId` — it does not re-derive scope from raw user input.

### Preview vs execute

| Phase | Purpose | Mutates target DB? |
|-------|---------|-------------------|
| **Preview** | Classify differences, surface conflicts, freeze contract | No (read-only on source + target) |
| **Execute** | Apply MERGE/DELETE + run post-metadata steps | Yes |

Preview is always required before execute. The agent and UI enforce **preview-first** workflows.

---

## 2. Architecture overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Consumers: UI (Env Sync widget), Agent chat, REST clients              │
│  Tools: sync_preview, sync_execute, search_sync_entities,               │
│         compare_catalogs, list_environments                             │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │
┌───────────────────────────────▼─────────────────────────────────────────┐
│  Application shell (`packages/sync/src/service/shell/`)             │
│  • previewSync()  → diff all recipe tables → SyncPlan → savePlan()    │
│  • executeSync()  → preflight → metadata tx → post-metadata pipeline  │
│  • searchEntities(), expandTreeIds(), fetchEntityDisplayName()          │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │
┌───────────────────────────────▼─────────────────────────────────────────┐
│  Domain                                                                 │
│  • published-definitions, recipes, diff-engine, catalog-drift           │
│  • environments, governance/freeze-windows, entity-registry types       │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │
┌───────────────────────────────▼─────────────────────────────────────────┐
│  Adapters: MSSQL pools (`getPool`), plan JSON on disk, SQLite run sink  │
└─────────────────────────────────────────────────────────────────────────┘
```

**Server bootstrap** (`packages/server/src/index.ts`) wires:

- `host.sync.project.dbProjectRoot` — repo root for bundle + deploy artifacts
- `configurePlanStore()` — `~/.mia/sync-plans/` (or `MIA_DATA_DIR/sync-plans/`)
- `configureSyncRunSink()` — SQLite run history
- `rebuildLiveSyncEnvironments()` — before each sync API call

---

## 3. Prerequisites — what must exist before preview

Preview (`previewSync`) will fail fast if any prerequisite is missing or invalid. This section describes **how each prerequisite is constructed** and **what preview checks**.

### 3.1 Boot order (server startup)

1. **MSSQL connections** — `setupMssql(projectRoot)` registers databases on `host.mssql.databases`. Each connection becomes a pool name usable as an environment name (fallback synthesis).
2. **Environment registry** — `loadPersistedSyncEnvironments()` + `rebuildLiveSyncEnvironments()`:
   - Prefer rows from SQLite `sync_environments` (admin UI)
   - Else read `deploy/sync/sync-environments.json`
   - Else synthesize one env per MSSQL connection (`role: both`)
   - Merge legacy `sync_env_overrides`
3. **Entity registry (SQLite)** — versioned `EntityDefinition` rows (tables, scopes, SCD2 strategy refs, policies). Edited via Sync Admin / entity registry UI.
4. **Entity `flowId`** — which flow template to publish for each entity (on the entity document itself). Bindings/ownership are compose-time stubs at Publish, not a tip table.
5. **Publish definitions** — `POST /api/sync/definitions/publish` → writes `sync-definitions/published/definitions.bundle.json`.
6. **Freeze window registry** — DB definitions installed via `installFreezeWindowRegistry()` for tenant `_default`.
7. **Plan store directory** — `MIA_DATA_DIR/sync-plans/` (default `~/.mia/sync-plans/`) created if missing.

Until step **5** completes, `getPublishedSyncDefinition()` throws for unknown entity types.

### 3.2 Runtime read path for a preview request

```
entityType + entityId + source + target
        │
        ▼
getPublishedSyncDefinition(host, projectRoot, entityType)
        │
        ▼
definitionToSyncRecipe(definition)
        │
        ▼
selectRecipeTables(recipe, enabledOptionalTables?)
        │
        ▼
getEnvironment(source), getEnvironment(target)
        │
        ▼
expandTreeIds() if recipe.selfJoinColumn set
        │
        ▼
detectCatalogDrift() + per-table diffTable()
        │
        ▼
savePlan(SyncPlan)
```

### 3.3 What preview validates (hard vs soft)

| Check | Preview | Execute | Source |
|-------|---------|---------|--------|
| Published definition exists | Hard | Hard | `getPublishedSyncDefinition` |
| Source not target-only | Hard | Hard | `getEnvironment` |
| Target not source-only | Hard | Hard | `getEnvironment` |
| Direction allowed | Hard | Hard | `assertSupportedSyncDirection` |
| Policies (allow / deny / approve) | Hard (HTTP + agent) | Hard (HTTP + agent) | Policy evaluator (`sync_preview` / `sync_execute`) |
| Catalog drift | Soft (warning) | Hard | `detectCatalogDrift` |
| Freeze windows active | Soft (warning) | Hard** | `evaluateFreezeWindows` |
| Scope conflicts | Surfaced | Hard | `detectScopeMisattribution` |
| Plan age | — | Hard (>1h) | `planTooOldToExecute` |

\** Unless `overrideFreezeWindow=true` on execute (audited).

---

## 4. The entity registry and published definitions

The system uses a **two-layer model**:

### Layer 1 — Entity registry (authoring, SQLite)

**Type:** `EntityDefinition` (`packages/sync/src/domain/entity-registry/types.ts`)

Stores the structural truth for each entity:

- Root table and key/label columns
- **Table closure** — every `EntityTable` with scope (`rootPk`, `sql`, etc.)
- SCD2 strategy reference (`strategyId`, `strategyVersion`)
- Policies (freeze window ids, risk multiplier)
- Provenance (manual, template, legacy migration)

The registry is **mutable** and versioned. Changes do not affect runtime sync until **publish**.

**Import/export shapes:** The registry UI uses **Format B** (`EntityDefinition` YAML/JSON). Git boot seeds use **Format A** (`AuthoredSyncDefinition` in `deploy/sync/artifacts/entities/`). Both compile from the same SQLite rows. See [deploy/sync/ARTIFACT-FORMATS.md](deploy/sync/ARTIFACT-FORMATS.md).

### Layer 2 — Published bundle (runtime, JSON)

**Path:** `sync-definitions/published/definitions.bundle.json`

**Shape:**

```json
{
  "version": 1,
  "publishedAt": "<ISO8601>",
  "publishedVersion": "<ISO8601>",
  "definitions": {
    "contract": { /* PublishedSyncDefinition */ },
    "dataset": { /* ... */ },
    ...
  }
}
```

**Type:** `PublishedSyncDefinition` (`packages/sync/src/domain/published-definitions.ts`)

Contains everything preview/execute need:

- Identity: `id`, `displayName`, `description`
- Root: `rootTable`, `idColumn`, `labelColumn`, `selfJoinColumn`
- Legacy mapping: `legacy.pipelineId`, `legacy.entrySproc`
- Governance: `governance.freezeWindowIds`, `governance.riskMultiplier`
- Strategy: `strategy.strategyId` (all bundled entities use `mymi-scd2`)
- Bindings: `bindings.serviceProfileRef`, `bindings.environmentPolicyRef`
- **Metadata:** `metadata.tables[]`, `metadata.executionOrder`, `metadata.reverseOrder`, `metadata.discrepancies`
- **Execution flow:** `executionFlow.steps[]` — ordered steps for execute
- Provenance and publish timestamps

### Publish pipeline

**Entry:** `publishSyncDefinitionsFromDb()` in `packages/server/src/api/sync/service/definitions.ts`

1. Load all `EntityDefinition` rows from SQLite.
2. Load per-entity `sync_definition_config` (flow preset, custom steps, bindings, ownership).
3. For each entity, `composeDefinition()`:
   - Build `metadata.tables[]` with predicates from table scopes (`predicateForTable`).
   - `orderEntityTables()` → parent→child `executionOrder`, child→parent `reverseOrder`.
   - Attach `executionFlow.steps` from config or flow template catalog.
4. Write `definitions.bundle.json`.
5. Invalidate cached bundle (`published-definition-registry.ts` reloads on mtime change).

**Admin trigger:** `POST /api/sync/definitions/publish` (requires admin role).

### Why publish matters

Preview snapshots the **execution contract** into the plan at preview time. Execute replays that contract — not live registry edits. If definitions change after preview, catalog checks may refuse execute; operators should **re-preview**.

---

## 5. Sync recipes and table closure

`definitionToSyncRecipe()` projects a `PublishedSyncDefinition` into `SyncRecipe` (`packages/sync/src/domain/recipes.ts`).

### SyncRecipeTable fields

| Field | Role |
|-------|------|
| `name` | Schema-qualified table e.g. `core.ContractColumn` |
| `scopeColumn` | FK binding to entity root, or `null` for rare whole-table scopes |
| `predicate` | SQL fragment with `{id}` or `{ids}` placeholders |
| `source` | How discovered (`fk-closure`, `pipeline`, `manual`, …) |
| `verified` | FK closure and legacy pipeline agree |
| `enabledByDefault` | Included in preview unless user opts out |
| `userControllable` | User may enable via `enabledOptionalTables` |

### Predicate instantiation

- `{id}` → single entity primary key (root id from user input).
- `{ids}` → expanded tree when `selfJoinColumn` is set (rules, content hierarchies).

Functions: `instantiatePredicate()`, `instantiatePredicateWithTree()` in `recipes.ts`.

### Execution order

- **`executionOrder`** — parents before children (for MERGE upserts).
- **`reverseOrder`** — children before parents (for DELETE).

### SCD2 strategy (`mymi-scd2`)

Bundled strategy (`packages/sync/src/domain/entity-registry/bundled-strategies.ts`):

- Hash columns **exclude** temporal/meta columns: `validFrom`, `validTo`, `isLocked`, `syncDate`, `deployDate`.
- On insert/update apply sets `validFrom = GETUTCDATE()`, `validTo = NULL`.

This matches legacy MyMI SCD2 semantics and keeps diff classification stable.

### Discrepancies

`SyncRecipeDiscrepancy` documents tables that differ between FK closure and legacy pipeline introspection:

- **`leak`** — FK-reachable but legacy pipeline did not touch (engine still syncs; documented).
- **`implicit`** — Pipeline touches table not FK-reachable (manually verified).
- **`drift`** — Pipeline references missing catalog object.

Discrepancies appear as preview warnings, not blockers.

---

## 6. Environments registry

**Type:** `SyncEnvironment` (`packages/sync/src/domain/environments.ts`)

| Field | Purpose |
|-------|---------|
| `name` | Connection name (matches MSSQL pool) |
| `displayName` | UI label |
| `role` | `source`, `target`, or `both` |
| `ringOrder` | Deployment ring ordering (0=dev, 1=uat, 2=prod) |
| `allowedSyncEnvironments` | When source: explicit environment allowlist (`null` = unrestricted) |
| `serviceUrls` | Named HTTP service base URLs (agent, etl, gate, custom) — preferred over legacy URL fields |
| `agentServiceBaseUrl` | Legacy post-sync Agent callback URL (merged into `serviceUrls`) |
| `etlServiceBaseUrl` | Legacy dataset/rule ETL deploy callback URL |
| `gateServiceBaseUrl` | Legacy gate metadata refresh URL |
| `defaultAccessMode` | `read_only` vs `read_write` — drives hosted policy |
| `allowedOperations` | Explicit operation allowlist for hosted mode |

### Direction policy

`assertSupportedSyncDirection(source, target)` enforces `source.allowedSyncEnvironments` when configured. Preview and execute both call this.

### Live rebuild

`rebuildLiveSyncEnvironments(host)` runs before sync API handlers so admin UI changes apply without server restart.

---

## 7. MSSQL connectivity

**Adapter:** `packages/sync/src/adapters/mssql/connection.ts`

- `getPool(host, environmentName)` returns a connection pool for that environment.
- `getMssqlConfig(host)` reads connection config from server bootstrap.

Preview and execute run SQL against **source** (read hashes, tree expansion, display names) and **target** (read hashes, writes on execute).

### Hosted access control

Environments with `defaultAccessMode: read_only` restrict DML/DDL via sync orchestration gates (`assertEnvOperationAllowed`). Agent tools and HTTP Sync allow/deny/approve live in Policies — factory seed `deploy/policies/defaults.json`, then DB/UI. Sync preview requires an allow (or absence of deny) for `sync_preview`; execute is governed the same way (`sync_execute`, typically DEV allow / UAT deny / PROD require approval).

---

## 8. Preview — end-to-end process

**Entry points:**

- `previewSync(input)` — `packages/sync/src/service/shell/orchestrator/preview.ts`
- Agent tool `sync_preview` — `tools.ts`
- REST `POST /api/sync/preview` — `routes.ts`

**Input (`PreviewInput`):**

```typescript
{
  host: SyncRuntimeHost
  entityType: EntityType      // e.g. "contract"
  entityId: string | number   // root PK
  source: string              // env name
  target: string
  force?: boolean             // remove 5M row cap per table
  enabledOptionalTables?: string[]
  userUpn?: string | null     // governance explainability
}
```

### Step-by-step

| # | Step | Implementation |
|---|------|----------------|
| 1 | Allocate `previewId` (UUID) and `planId` | `allocPlanId()`, emit `SyncPreviewStarted` |
| 2 | Load published definition | `getPublishedSyncDefinition()` |
| 3 | Project recipe, select tables | `definitionToSyncRecipe()`, `selectRecipeTables()` |
| 4 | Validate environments | `getEnvironment()`, roles, `assertSupportedSyncDirection`, PROD guard |
| 5 | Evaluate governance (soft) | `evaluateFreezeWindows()`, allowlist warnings |
| 6 | Resolve display name | `fetchEntityDisplayName()` on source root table |
| 7 | Expand tree ids (if applicable) | `expandTreeIds()` when `selfJoinColumn` set |
| 8 | Catalog drift preflight | `detectCatalogDrift()` across recipe table schemas |
| 9 | Discover PK columns | `fetchPkColumns()` per table on source |
| 10 | **Parallel per-table diff** | `mapWithConcurrency(..., PREVIEW_TABLE_CONCURRENCY=4)` → `diffTable()` |
| 11 | Build dependency graph | `buildDependencyGraph()` for UI |
| 12 | Assemble `SyncPlan` | totals, samples, `executionContract`, `decisionLog`, `governanceDecision` |
| 13 | Persist plan | `savePlan()` — memory + disk JSON + SQLite sink |
| 14 | Emit `SyncPreviewCompleted` | return plan to caller |

### Preview options

| Option | Effect |
|--------|--------|
| `force: true` | Removes per-table **5 million row** cap on hash reads (`rowCap: MAX_SAFE_INTEGER`) |
| `enabledOptionalTables: string[]` | Includes FK-only / user-controllable tables excluded by default |

### Concurrency note

Table diffs run with concurrency **4** (`PREVIEW_TABLE_CONCURRENCY`). Higher values exhaust the MSSQL pool and cause flaky zero-count failures.

---

## 9. The SyncPlan artifact

**Type:** `SyncPlan` (`packages/sync/src/service/shell/plan-store.ts`)

### Core fields

| Field | Description |
|-------|-------------|
| `planId` | UUID — execute references this |
| `entity` | `{ type, id, displayName }` |
| `source`, `target` | Environment names |
| `createdAt` | ISO timestamp |
| `tables[]` | Per-table diff results |
| `totals` | Aggregated counts |
| `dependencyGraph` | Nodes/edges for UI graph |
| `recipeSnapshot` | Frozen table list + optional table selection |
| `executionContract` | Frozen definition + flow for execute |
| `decisionLog` | Explainability records |
| `governanceDecision` | Freeze/allowlist evaluation at preview time |
| `preflight` | Catalog compatibility |

### TTL

| Limit | Value | Enforced by |
|-------|-------|-------------|
| Disk/memory retention | 24 hours | plan store cleanup |
| Execute allowed | 1 hour from `createdAt` | `planTooOldToExecute()` |

### Per-table result (`SyncPlanTable`)

- `table` — schema-qualified name
- `scopePredicate` — instantiated predicate used
- `counts` — `insert`, `update`, `delete`, `unchanged`, `conflicts`
- `samples` — up to 50 rows per bucket for UI
- `conflicts` — scope misattribution details
- `warnings` — per-table issues (e.g. diff failure)

### Execution contract (snapshotted)

Execute **requires** `plan.executionContract`. Plans without it are rejected (legacy plans must re-preview).

The contract includes:

- Definition id + published version
- Governance snapshot
- Allowed schemas
- Metadata tables + execution/reverse order
- **Flow steps** — full ordered execute pipeline

This guarantees **what you previewed is what you execute**.

---

## 10. Diff engine — how changes are detected

**Module:** `packages/sync/src/domain/diff-engine/`

**Per-table entry:** `diffTable(host, recipe, table, entityId, source, target, pkColumns, options)`

### Algorithm (per table)

1. **Instantiate predicate** — restrict source and target row sets to entity scope.
2. **Discover hash columns** — `fetchTableColumns()` excludes identity, computed, and meta columns (`META_EXCLUDED_COLUMNS`).
3. **Compute row hashes on source and target in parallel** — `fetchPkHash()`:
   - `HASHBYTES('SHA2_256', CONCAT_WS(...))` over non-meta columns
   - Deterministic session settings (`DETERMINISTIC_SESSION_PREFIX`) for culture-safe comparison
   - Default cap: **5M rows** per table (unless `force`)
4. **Outer-join on primary key** — classify each PK:
   - Source only → **INSERT**
   - Target only → **DELETE**
   - Both, hash differs → **UPDATE**
   - Both, hash same → **UNCHANGED**
5. **Conflict detection** — `detectScopeMisattribution()` on INSERT candidates (see §11).
6. **Sample fetch** — `fetchSamples()`, `fetchUpdateSamples()` for UI.

### Change types

Enum: `SyncPlanChangeType` (`packages/sync/src/domain/enums.ts`)

- `insert`, `update`, `delete`, `unchanged`
- `conflicts` — not a DML action; blocks execute

---

## 11. Conflicts and scope misattribution

**Module:** `packages/sync/src/domain/diff-engine/conflicts.ts`

A **conflict** occurs when preview expects to **INSERT** a row (PK exists on source, missing on target under scope), but the **same PK already exists on target under a different parent** (`scopeColumn` mismatch).

Without detection, execute would hit PK violations and roll back the entire metadata transaction.

### Behaviour

| Phase | Behaviour |
|-------|-----------|
| Preview | Conflicts counted per table; samples in `SyncPlanTable.conflicts` |
| Execute | **Hard refuse** if `totals.conflicts > 0` |

**Fix:** Correct target metadata (re-attach rows to correct parent), then re-preview.

---

## 12. Optional tables

Some tables are **FK-only** — reachable in closure but not verified by legacy pipeline introspection. They are marked `userControllable: true` and `enabledByDefault: false`.

**Default:** excluded from preview totals.

**To include:** pass `enabledOptionalTables: ["core.Step", ...]` to preview (UI toggle / API field).

Preview warns when optional tables are excluded:

> FK-only tables excluded by default: … Enable them explicitly to include closure-only rows in the preview.

The selection is frozen in `recipeSnapshot.enabledOptionalTables` on the plan.

---

## 13. Execute — end-to-end process

**Entry points:**

- `executeSync(planId, opts)` — `packages/sync/src/service/shell/orchestrator/execute.ts`
- Agent tool `sync_execute` (requires `confirm: true`)
- REST `POST /api/sync/execute/:planId`
- SSE progress: `GET /api/sync/execute/:planId/stream`

**Input (`ExecuteOptions`):**

```typescript
{
  host: SyncRuntimeHost
  confirm: true              // mandatory explicit confirmation
  userUpn?: string | null
  overrideFreezeWindow?: boolean
  onProgress?: (ExecuteProgress) => void
}
```

### Pre-flight (before any writes)

| # | Check |
|---|-------|
| 1 | `confirm === true` |
| 2 | Plan exists, not expired (1h) |
| 3 | Environment roles + direction |
| 4 | PROD guard |
| 5 | Hosted policy — target `read_only` / missing `sync_execute` in `allowedOperations` |
| 6 | `executionContract` present |
| 7 | Catalog drift — **fatal** (preview only warned) |
| 8 | Freeze windows — **fatal** unless override |
| 9 | Scope conflicts — **fatal** |
| 10 | `getSyncRunSink().start()` — record run |
| 11 | `fetchPkColumns()` for contract tables |

### Execution flow driver

Execute walks `executionContract.flow.steps` **in definition order**. The list is frozen at preview time from the entity’s published flow template (see `deploy/sync/artifacts/flow-templates.json` and admin overrides).

The orchestrator treats the flow as **three bands** — only the middle band is a SQL transaction:

```
┌─────────────────────────────────────────────────────────────────────────┐
│  PRE-TRANSACTION (contract only, before metadata)                       │
│  auditCheck, targetLock — direct sprocs on target pool, auto-commit     │
│  Failure → step warning, execution CONTINUES                            │
├─────────────────────────────────────────────────────────────────────────┤
│  METADATA (all entity types)                                            │
│  metadataSync → runMetadataSync() — ONE sql.Transaction on target       │
│  MERGE/DELETE across recipe tables; tx.commit() or tx.rollback()       │
│  Failure → THROWS; metadata changes rolled back; execute aborts        │
├─────────────────────────────────────────────────────────────────────────┤
│  POST-METADATA (entity-specific, after metadata commit)               │
│  runPostMetadataPipeline() — sprocs + HTTP per step, auto-commit each │
│  Failure → step warning per step, execution CONTINUES to next step      │
└─────────────────────────────────────────────────────────────────────────┘
```

**Phase labels** (`SyncExecutionContractStep.phase`) describe intent; the **failure boundary** is what matters operationally:

| Phase label | What actually runs | In `sql.Transaction`? |
|-------------|-------------------|------------------------|
| `pre-transaction` | `auditCheck`, `targetLock` (contract) | **No** — `preTxStep()` on `tgtPool` |
| `metadata` | `metadataSync` → `runMetadataSync()` | **Yes** — single target transaction |
| `post-metadata` | All remaining steps | **No** — each sproc/HTTP call commits independently |
| `post-commit` | Same as post-metadata in practice | **No** |

Implementation split in `execute.ts`:

1. Steps **before** the first `metadataSync` → pre-transaction handler (`preTxStep`)
2. The `metadataSync` step → `runMetadataSync()` (transaction)
3. Steps **after** `metadataSync` → `runPostMetadataPipeline()` (`callStep` per step)

### What “in transaction” means (and what it does **not**)

When documentation or tool descriptions say execute runs “inside a single transaction with rollback on error”, that applies **only to the metadata-sync band** — the MERGE/DELETE of rows across recipe tables (`core.Contract`, `core.Dataset`, gate tables, etc.).

It does **not** mean:

- Contract deploy sprocs (`uspCreateDataset`, `uspCreateDatasetFKs`, `uspDeployETL…`, …) participate in that transaction
- HTTP callbacks (ETL deploy, Agent pipeline register) are rolled back if a later step fails
- A failed post-metadata step undoes metadata rows that already committed

Post-metadata steps call `trackedExecute(host, pool.request(), …)` on the **connection pool**, not on `tx.request()`. On SQL Server each procedure runs in **auto-commit** mode unless the proc itself opens an explicit transaction. So when `contract-create-fks` calls `core.uspCreateDatasetFKs` and the proc errors with “too many arguments”, **only that procedure call fails** — any metadata MERGE/DELETE from the prior `metadataSync` step is **already committed** and remains visible on the target.

This matches legacy behaviour: the old monolithic `uspSyncCoreObjectsTran` family combined metadata + deploy; the new orchestrator **split** metadata (transactional) from deploy side-effects (best-effort steps).

### Failure semantics and operator-visible outcomes

| Failure location | Metadata rows on target | Later steps run? | Run status | `executeSync` return |
|------------------|-------------------------|------------------|------------|----------------------|
| Pre-flight (conflicts, catalog, …) | Unchanged | No | Failed | `success: false`, throws or returns error |
| Pre-transaction step (`auditCheck`, pre-lock) | Unchanged* | Yes — metadata still runs | Failed if any warning | `success: false` if warnings |
| **Metadata sync** (`metadataSync`) | **Rolled back** | No — pipeline not reached | Failed | `success: false`, error thrown |
| **Post-metadata step** (e.g. `contract-create-fks`) | **Already committed** | Yes — next steps still attempted | Failed | `success: false`, `error` lists step warnings |

\*Pre-transaction failures are recorded via `preTxStep()` which **does not abort** the flow — warnings are collected and metadata sync still proceeds. This is intentional so a flaky audit sproc does not block data sync; operators should review warnings.

Post-metadata failures use `callStep()` in `post-metadata-pipeline.ts` — catch, emit `SyncExecuteStepFailed`, push to `stepWarnings`, **continue**.

Final completion logic (`execute.ts`):

```text
hasStepFailures = stepWarnings.length > 0
status = hasStepFailures ? Failed : Success
return { success: !hasStepFailures, error: stepErrorSummary }
```

So a run can show **Failed** in history while **metadata diffs are already live on target** — exactly the situation when `contract-create-fks` fails on an out-of-date `uspCreateDatasetFKs` signature. The deployment pipeline did not finish cleanly; the database is in a **partially deployed** state and may need manual follow-up (fix proc version, re-run deploy steps, or re-preview/execute).

Metadata-only failure path: `runMetadataSync` rolls back, re-enables FK checks (best-effort), throws. `executeSyncInner` catch block attempts **best-effort `targetUnlock`** if a lock step was present in the flow.

Missing service URL (ETL/Agent/Gate) → post-metadata step warning, same partial-failure model.

---

## 14. Metadata sync transaction

**Function:** `runMetadataSync()` — `packages/sync/src/service/shell/orchestrator/metadata-sync.ts`

This is the **only** execute phase wrapped in `new sqlMod.Transaction(tgtPool)`.

### Transaction lifecycle

1. Identify **affected tables** (insert + update + delete count > 0) — only these get `NOCHECK` / `CHECK CONSTRAINT`.
2. `tx.begin()`
3. `ALTER TABLE … NOCHECK CONSTRAINT ALL` on affected tables.
4. **Upserts** in `executionOrder` (parents → children):
   - `maybeArchive()` — archive-table triggers when configured (uses target pool outside tx for trigger probe; writes go through `tx`)
   - `applyInsertsUpdates()` — MERGE via temp table (`apply.ts`)
5. **Deletes** in `reverseOrder` (children → parents):
   - `applyDeletes()`
6. `WITH CHECK CHECK CONSTRAINT ALL` on affected tables.
7. `tx.commit()` — metadata is now **durable** on target.

### On metadata failure

- `tx.rollback()` — MERGE/DELETE undone.
- Best-effort re-enable FK constraints on affected tables (even if tx aborted).
- Error propagates; **post-metadata pipeline never runs**.

### Apply implementation

**Module:** `packages/sync/src/service/shell/orchestrator/apply.ts`

- Reads changed rows from **source** using the same scope predicates as preview.
- Writes to **target** through `tx.request()` (participates in the transaction).
- Respects PK column sets from `fetchPkColumns()`.

---

## 15. Post-metadata pipeline

**Function:** `runPostMetadataPipeline()` — `packages/sync/src/service/shell/orchestrator/post-metadata-pipeline.ts`

Runs **after** `metadataSync` commits. Each step is isolated: success or failure of one step does not roll back previous steps (including committed metadata).

### Step kinds (representative)

| Kind | Mechanism | Connection / service |
|------|-----------|----------------------|
| `auditCheck` | `runAuditCheckDirect` (`syncOrNot`, etc.) | Target or source pool |
| `targetLock` / `targetUnlock` | `setContractLockDirect` | Target pool |
| `contractUndeploy` | `undeployMarkedContract` | Target pool |
| `contractPreScript` / `contractPostScript` | `runContractDeploymentScriptsDirect` | Target pool |
| `contractCreateStageDataset` … `contractCreateFactDataset` | `createDataset` → `core.uspCreateDataset` | Target pool |
| `contractCreateDatasetFks` | `createDatasetFKs` → `core.uspCreateDatasetFKs` | Target pool |
| `contractDeployEtl` | `deployETL` → `core.uspDeployETL2CustomTransformation` | Target pool |
| `contractDeployRoutine` | `deployRoutine` → `core.uspDeployRoutine` | Target pool |
| `datasetDeploy` | `POST {etl}/dataset/deploy` | ETL HTTP |
| `rulesDeploy` | `POST {etl}/rules/deploy` | ETL HTTP |
| `pipelineRegister` | `POST {agent}/pipeline/register` | Agent HTTP |
| `pipelineStart` | `POST {agent}/pipeline/start` | Agent HTTP |
| `metaRefresh` | `GET {gate}/api/meta/refresh` | Gate HTTP |
| `handleDependencies` | `EXEC core.uspObjectDependencies` | Target pool |
| `syncDate` / `deployDate` | `runAuditCheckDirect` audit actions | Source or target pool |

### `contract-create-fks` / `uspCreateDatasetFKs` (example)

Step id: `contract-create-fks` (`kind: contractCreateDatasetFks`). Invokes `createDatasetFKs()` in `contract-deploy.ts`, which executes `core.uspCreateDatasetFKs` on the **target** with:

| Parameter | Value |
|-----------|--------|
| `@contractName` | resolved from `core.Contract` on target |
| `@isDebug` | `false` |
| `@referencedSchemaName` | `NULL` (reconcile all FKs for contract) |
| `@referencedTableName` | `NULL` |
| `@isExtraLogged` | `false` |

This step runs **after** metadata commit and **after** the five `contract-create-dataset-*` steps. A signature mismatch on target (“too many arguments specified” / wrong param count) is a **target `core` schema version issue**, not a sync-plan bug. Metadata rows are already on target; the run fails with a step warning; later steps (ETL deploy, routines, unlock, dates) may still run depending on where the failure occurred.

### Subject reference resolution

Some steps need a related id (`resolveStepSubjectId`):

| `subjectRef` | Resolves to |
|--------------|-------------|
| `entityId` | Plan entity id (default) |
| `ruleInputDatasetId` | `core.Rule.inputDatasetId` for rule id |
| `contractPipelineId` | `core.Pipeline.pipelineId WHERE contractId = @id` |

### Contract deploy module

**Module:** `packages/sync/src/service/shell/orchestrator/contract-deploy.ts`

Thin typed wrapper around target worker procs (no linked-server hop). Proc names are configurable via `ContractProcConfig` / `DEFAULT_PROCS` for non-standard targets.

---

## 16. Per-entity-type reference

Six bundled entity types ship with the product. All use SCD2 strategy **`mymi-scd2`**.

| Entity id | Display | Root table | PK column | Label | Tree FK |
|-----------|---------|------------|-----------|-------|---------|
| `contract` | Contract | `core.Contract` | `contractId` | `name` | — |
| `dataset` | Dataset | `core.Dataset` | `datasetId` | `name` | — |
| `rule` | Rule | `core.Rule` | `ruleId` | `name` | `parentRuleId` |
| `pipelineActivity` | Pipeline Activity | `core.Pipeline` | `pipelineId` | `name` | — |
| `gateMetadata` | Gate Metadata | `gate.MetaTable` | `tableId` | `name` | — |
| `content` | Content | `gate.Content` | `contentId` | `title` | `parentContentId` |

### Table counts (default enabled)

Approximate default table closure sizes (optional tables excluded):

| Entity | ~Tables enabled | Legacy pipeline | Legacy sproc |
|--------|-----------------|-----------------|--------------|
| contract | 14 | 788 | `core.uspSyncCoreObjectsTran` |
| dataset | 12 | 789 area | (dataset flow) |
| rule | 11 | 791 | `core.uspSyncRuleObjectsTran` |
| pipelineActivity | 3 (+1 optional) | 798 | `core.uspSyncPipelineObjectsTran` |
| gateMetadata | 7 (+3 optional) | 780 | `core.uspSyncDataListObjectsTran` |
| content | 5 (+1 optional) | 692 | `core.uspSyncContentObjectsTran` |

**Authoritative table lists** are in `definitions.bundle.json` after publish.

### Optional (FK-only) tables by entity

Excluded unless `enabledOptionalTables` explicitly enables them:

- **content:** `gate.UserGroupPermission`
- **contract:** `core.Step`, `core.Rule`, `core.RuleColumn`, `core.RuleCondition`, `core.RuleLink`, `core.RuleConditionValue` (via EXISTS through contract closure)
- **dataset:** reverse dependents on rules/steps (see bundle)
- **gateMetadata:** `gate.Content`, `gate.ContentLink`, `gate.UserGroupPermission`
- **pipelineActivity:** `core.Step`

### Execute step sequences (default flow templates)

Steps below are the **default** order from `deploy/sync/artifacts/flow-templates.json`. Published definitions may differ if operators edited flow config. Every entity type includes **`metadataSync`** as the transactional core.

#### `contract` — full deploy (21 steps)

| # | Step id | Phase | Kind | What it does |
|---|---------|-------|------|--------------|
| 1 | `audit-check` | pre-transaction | `auditCheck` | Target audit validation (`syncOrNot`) |
| 2 | `target-lock` | pre-transaction | `targetLock` | Lock contract on target |
| 3 | `metadataSync` | metadata | `metadataSync` | **Transactional MERGE/DELETE** |
| 4 | `pipeline-register` | post-metadata | `pipelineRegister` | Agent: register contract pipelines |
| 5 | `contract-undeploy` | post-metadata | `contractUndeploy` | Undeploy marked contract objects |
| 6 | `contract-unlock-after-undeploy` | post-metadata | `targetUnlock` | Unlock after undeploy |
| 7 | `audit-check-2` | post-metadata | `auditCheck` | Second audit check |
| 8 | `contract-lock-for-deploy` | post-metadata | `targetLock` | Lock for deployment |
| 9 | `contract-pre-script` | post-metadata | `contractPreScript` | Pre-deploy scripts |
| 10 | `contract-create-dataset-stage` | post-metadata | `contractCreateStageDataset` | `uspCreateDataset` (stage) |
| 11 | `contract-create-dataset-archive` | post-metadata | `contractCreateArchiveDataset` | `uspCreateDataset` (archive) |
| 12 | `contract-create-dataset-list` | post-metadata | `contractCreateListDataset` | `uspCreateDataset` (list) |
| 13 | `contract-create-dataset-dim` | post-metadata | `contractCreateDimDataset` | `uspCreateDataset` (dim) |
| 14 | `contract-create-dataset-fact` | post-metadata | `contractCreateFactDataset` | `uspCreateDataset` (fact) |
| 15 | `contract-create-fks` | post-metadata | `contractCreateDatasetFks` | `uspCreateDatasetFKs` |
| 16 | `contract-deploy-etl` | post-metadata | `contractDeployEtl` | Deploy ETL transformations |
| 17 | `contract-deploy-routine` | post-metadata | `contractDeployRoutine` | Deploy routines |
| 18 | `contract-post-script` | post-metadata | `contractPostScript` | Post-deploy scripts |
| 19 | `contract-unlock-after-deploy` | post-metadata | `targetUnlock` | Unlock after deploy |
| 20 | `setSyncDate` | post-metadata | `syncDate` | Stamp sync date (source audit) |
| 21 | `setDeployDate` | post-metadata | `deployDate` | Stamp deploy date (target audit) |

Steps 4–21 are **not** rolled back if a later step fails.

#### `dataset` (3 steps)

| # | Step id | Kind |
|---|---------|------|
| 1 | `metadataSync` | `metadataSync` |
| 2 | `dataset-deploy` | `datasetDeploy` (ETL HTTP) |
| 3 | `syncDate` | `syncDate` |

#### `rule` (6 steps)

| # | Step id | Kind |
|---|---------|------|
| 1 | `metadataSync` | `metadataSync` |
| 2 | `dataset-deploy` | `datasetDeploy` (input dataset via `ruleInputDatasetId`) |
| 3 | `rules-deploy` | `rulesDeploy` |
| 4 | `handle-dependencies` | `handleDependencies` |
| 5 | `syncDate` | `syncDate` |
| 6 | `deployDate` | `deployDate` |

#### `pipelineActivity` (2 steps)

| # | Step id | Kind |
|---|---------|------|
| 1 | `metadataSync` | `metadataSync` |
| 2 | `pipeline-register` | `pipelineRegister` |

#### `gateMetadata` (3 steps)

| # | Step id | Kind |
|---|---------|------|
| 1 | `metadataSync` | `metadataSync` |
| 2 | `meta-refresh` | `metaRefresh` (Gate HTTP) |
| 3 | `pipeline-start` | `pipelineStart` — pipeline name `"All Lists content item population"` |

#### `content` (2 steps)

| # | Step id | Kind |
|---|---------|------|
| 1 | `metadataSync` | `metadataSync` |
| 2 | `handle-dependencies` | `handleDependencies` (`objectName: content`) |

#### `metadataOnly` (1 step)

| # | Step id | Kind |
|---|---------|------|
| 1 | `metadataSync` | `metadataSync` |

Use when an entity definition should apply row changes only — no ETL/Agent/Gate/contract deploy callbacks.

### Post-metadata flow summary (one line per entity)

| Entity | After metadata commit |
|--------|----------------------|
| **contract** | Agent register → undeploy → lock/unlock cycle → create 5 dataset types → FKs → ETL → routines → scripts → unlock → dates |
| **dataset** | ETL `dataset/deploy` → sync date |
| **rule** | ETL dataset deploy (input) → rules deploy → dependencies → dates |
| **pipelineActivity** | Agent `pipeline/register` |
| **gateMetadata** | Gate `meta/refresh` → Agent pipeline start |
| **content** | `handleDependencies("content")` |

Flow templates: `deploy/sync/artifacts/flow-templates.json`.

### Tree expansion entities

**rule** and **content** set `selfJoinColumn`. Preview calls `expandTreeIds()` on the **source** environment:

```sql
;WITH tree AS (
  SELECT [pk] FROM table WHERE [pk] = @rootId
  UNION ALL
  SELECT child.[pk] FROM table child
  INNER JOIN tree parent ON child.[fk] = parent.[pk]
)
SELECT [pk] FROM tree
```

Predicates using `{ids}` receive the full descendant set; `{id}` remains the user-selected root.

### Example: gate metadata by id

User goal: *"sync gate table 2545 from uat to dev"*

1. `entityType = gateMetadata`, `entityId = 2545` (root `gate.MetaTable.tableId`)
2. Preview diffs all enabled gate metadata tables scoped to that meta table row.
3. Execute runs metadata sync + Gate refresh + content population pipeline.

Name resolution: `search_sync_entities` with `mode=id` or auto-detect numeric id (`resolveSyncEntitySearch` in `search.ts`).

---

## 17. Agent tools and chat integration

**Factory:** `packages/sync/src/service/shell/tools.ts`  
**Registration:** `packages/server/src/api/runs/tooling/registry.ts`

| Tool | Purpose |
|------|---------|
| `list_environments` | Returns configured environments and roles |
| `search_sync_entities` | Lookup entity row by id or display name on source |
| `compare_catalogs` | Full schema comparison (drift investigation) |
| `sync_preview` | Runs `previewSync()`, returns summary + dashboard markdown |
| `sync_execute` | Runs `executeSync(planId, { confirm: true })` — refuses without explicit confirm |

### Valid bundled entity types

`contract`, `dataset`, `rule`, `pipelineActivity`, `gateMetadata`, `content`

(Extensible via entity registry publish for tenant-defined types.)

### Chat doctrine

**Prompt:** `packages/agent/prompts/abi-sync.md`

Rules enforced in product behaviour:

1. **Preview-first** — agent must stop after `sync_preview`; no `sync_execute` in same turn.
2. **Numeric id** → call `sync_preview` directly; do not search by name.
3. **Display name** → `search_sync_entities` then `sync_preview`.
4. **Never** use `search_catalog` for entity instance lookup.
5. Conflicts block execution — show conflict table, not dashboard.

### Deterministic intent parsing

**Module:** `packages/sync/src/domain/sync-operation-intent.ts`

Parses goals like `sync contract abcd from uat to dev` into `SyncOperationIntent` (entity type, id vs name query, route). Injected into agent system messages to suppress catalog false-disambiguation and steer tool choice.

---

## 18. REST API surface

**Registrar:** `registerSyncRoutes()` in `packages/server/src/api/sync/routes.ts`

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/sync/environments` | List environments |
| GET | `/api/sync/definitions` | List published definitions (summary) |
| POST | `/api/sync/definitions/publish` | Compile + publish bundle (admin) |
| GET/PUT/DELETE | `/api/sync-definition-configs` | Admin per-entity sync config |
| GET | `/api/sync/search` | `searchEntities` (`entityType`, `source`, `q`, `mode`) |
| POST | `/api/sync/preview` | Build SyncPlan |
| GET | `/api/sync/plan/:planId` | Load persisted plan |
| POST | `/api/sync/execute/:planId` | Execute plan |
| GET | `/api/sync/execute/:planId/stream` | SSE execute progress |
| GET | `/api/sync/history` | Audit + agent history |
| GET | `/api/sync/runs` | Sync run list |

**Additional transport:**

- `registerSyncEnvironmentRoutes` — CRUD environments
- `registerEntityRegistryRoutes` — entity definition admin
- `registerFreezeWindowRoutes` — freeze window admin

---

## 19. Governance, safety rails, and approvals

### Freeze windows

**Module:** `packages/sync/src/domain/governance/freeze-windows.ts`

- Referenced by id on each definition (`governance.freezeWindowIds`).
- Evaluated at preview (warning) and execute (block).
- Override: `overrideFreezeWindow: true` on execute (audited in decision log).

### Policies (single governance rail)

Allow / deny / require approval live in **Policies**. Agent tools and HTTP Sync share `buildPolicyContext` (always default-deny). Admin does not bypass. Seeded defaults are not locked to `hosted_user`.

Environments are Sync topology only. `AGENT_HOSTED_MODE` is workspace isolation only, not governance.

**Removed:** `SYNC_ALLOW_PROD`, Environment Access UI, env_derived Access seeding, HTTP Sync HostedUser hardcode, admin developer default-allow for policy eval.

### Plan staleness

Plans older than **1 hour** cannot execute — forces re-preview against current data.

### Approvals

HTTP Sync RequireApproval returns `409 approval_required` with an `approvalId`. Env Sync approves via `/api/sync/policy-approvals/:id/approve`, then retries. Agent Sync continues to use run-tool approvals.
### Risk multiplier

`governance.riskMultiplier` on definitions is snapshotted into plans for proposer/annotation tooling (`packages/sync/src/service/core/proposer/`).

---

## 20. Events, persistence, and audit

### Events

**Emitter:** `emitSyncEvent()` — `packages/sync/src/service/shell/events.ts`  
**Server sink:** `packages/server/src/boot/sync.ts` → SSE broadcast

Key event types (`@mia/shared-enums`):

- Preview: `SyncPreviewStarted`, `SyncPreviewTableStart/Done/Failed`, `SyncPreviewCompleted/Failed`
- Execute: `SyncExecuteStarted`, `SyncExecuteStep`, `SyncExecuteTableStart/Done`, `SyncExecuteCompleted/Failed`, `SyncExecuteDriftRevalidated`

### Plan persistence

**Store:** `packages/sync/src/service/shell/plan-store.ts`

- In-memory cache
- Disk: `~/.mia/sync-plans/{planId}.json` (or under `MIA_DATA_DIR`)
- SQLite: `sync_runs.plan_json` via run sink

### Run history

**Sink:** `packages/sync/src/service/shell/run-sink.ts`  
**Bridge:** `configureSyncRunSink()` — records start/finish, actor, totals, errors.

### Audit

Server records preview/execute actions via `recordSyncAudit` (routes layer) for compliance trails.

---

## 21. Configuration reference

| Artifact | Path | Purpose |
|----------|------|---------|
| Published bundle | `sync-definitions/published/definitions.bundle.json` | Runtime sync contracts |
| Environment file | `deploy/sync/sync-environments.json` | Default env registry |
| Flow templates | `deploy/sync/artifacts/flow-templates.json` | Execute step templates |
| Entity seeds | `deploy/sync/artifacts/entities/*.json` | Initial registry seeds |
| Plan storage | `MIA_DATA_DIR/sync-plans/` | Persisted SyncPlans |

### Environment variables

Perf/debug only (not governance):

| Variable | Effect |
|----------|--------|
| `SYNC_PREVIEW_CONCURRENCY` | Parallel table diffs (default 4) |
| `SYNC_DEBUG_SQL` | Extra SQL telemetry when `1` |

Governance (allow / deny / approve) is configured in **Policies**, not process.env.

### Orchestrator tuning (`db-helpers.ts`)

| Constant | Default | Effect |
|----------|---------|--------|
| `PREVIEW_TABLE_CONCURRENCY` | 4 | Parallel table diffs |

---

## 22. Operator workflows

### Manual sync (UI widget)

1. Select **source** and **target** environments.
2. Select **entity type**.
3. Search by **name** or **id** (`/api/sync/search`) — pick row.
4. Optionally enable **optional tables** and **force** (uncapped diff).
5. Click **Preview** → `POST /api/sync/preview` → plan loads in widget.
6. Review totals, samples, conflicts, dependency graph.
7. If acceptable, **Execute** → `POST /api/sync/execute/:planId` with confirm.

### Agent-driven sync (chat)

1. User states goal with entity type, instance (name or id), and route.
2. Agent calls `list_environments` if needed.
3. Resolve instance: numeric id → `sync_preview` directly; name → `search_sync_entities` first.
4. `sync_preview` → present plan (dashboard or conflict table). **Stop.**
5. User explicitly confirms in a **separate** message.
6. Agent calls `sync_execute` with `confirm: true`.

### When preview shows conflicts

Do **not** execute. The plan is blocked. Fix target parent/scope assignments for listed PKs, then re-preview.

### When preview shows catalog drift

Preview may complete with warnings. Execute will **refuse** until schemas align (`compare_catalogs` helps investigate).

### When execute fails post-metadata

Metadata may already be committed. Check run warnings, Agent/ETL/Gate service URLs on target environment, and step logs in Operations Log. Re-run post steps manually if needed after fixing service connectivity.

### Publishing definition changes

1. Edit entity in Sync Admin / entity registry.
2. Adjust sync definition config (flow, bindings) if needed.
3. `POST /api/sync/definitions/publish`.
4. All **new** previews use updated bundle; existing plans remain on old contract until re-previewed.

---

## Appendix A — Key functions index

| Function | File |
|----------|------|
| `previewSync` | `orchestrator/preview.ts` |
| `executeSync` | `orchestrator/execute.ts` |
| `runMetadataSync` | `orchestrator/metadata-sync.ts` |
| `runPostMetadataPipeline` | `orchestrator/post-metadata-pipeline.ts` |
| `diffTable` | `domain/diff-engine/index.ts` |
| `definitionToSyncRecipe` | `domain/published-definitions.ts` |
| `getPublishedSyncDefinition` | `domain/published-definitions.ts` |
| `selectRecipeTables` | `domain/recipes.ts` |
| `searchEntities` | `orchestrator/search.ts` |
| `expandTreeIds` | `orchestrator/search.ts` |
| `detectCatalogDrift` | `domain/catalog-drift.ts` |
| `evaluateFreezeWindows` | `domain/governance/freeze-windows.ts` |
| `savePlan` / `loadPlan` | `runtime/plan-store.ts` |
| `publishSyncDefinitionsFromDb` | `server/.../service/definitions.ts` |
| `parseSyncOperationIntent` | `domain/sync-operation-intent.ts` |

---

## Appendix B — Glossary

| Term | Definition |
|------|------------|
| ABI | Application Business Interface — MyMI metadata model (core.*, gate.* schemas) |
| Bundle | Compiled `definitions.bundle.json` runtime artifact |
| Closure | FK-reachable set of tables for an entity root |
| SCD2 | Slowly changing dimension type 2 — temporal validity columns |
| Scope column | FK tying a dependent row to its entity root |
| Scope misattribution | PK exists on target under wrong parent |
| Execution contract | Frozen definition + flow snapshotted into SyncPlan |
| Ring order | Environment ordering dev → uat → prod |

---

*This document reflects the implementation in the agent001 repository. For exact table predicates and step lists per entity, consult `sync-definitions/published/definitions.bundle.json` after your environment's last publish.*
