# Sync model — terminology

One-page glossary for how sync concepts relate in code.

## Authority chain

```
Sync metadata (DB)       — step types (handlers), flows (ordered steps)
        +
Entity registry (DB)     — table structure, scopes, SCD2 refs, flow reference + bindings
        ↓ publish
Published sync definition — frozen bundle (definitions.bundle.json)
        ↓ preview / execute
Three execution regions  — before metadataSync | metadataSync (SQL tx) | after metadataSync
```

**One rule:** entities **reference** a flow. Steps run in **array order**; `metadataSync` is the split point.

## Terms

| Term | Meaning |
|------|---------|
| **Entity registry** | Versioned DB records (`EntityDefinition`): root table, dependent tables, scope per table, policies. |
| **Sync definition** | Full operational contract: structure + governance + bindings + execution flow. |
| **Authored sync definition** | JSON shape before publish (`AuthoredSyncDefinition`). Repo drafts under `deploy/sync/artifacts/entities/`. |
| **Published sync definition** | Authored shape + `publishedAt` / `publishedVersion`. **Runtime authority** for preview/execute. |
| **Execution contract** | Snapshot on `SyncPlan` that reproduces preview at execute: definition metadata + flow steps + governance. |
| **SyncPlan** | Persisted preview envelope: entity, envs, `executionContract`, per-table `changeSet`, `stats`, samples, warnings. |
| **changeSet** | Per-table insert / update / delete PK lists — **execute authority**. Built at preview; required by `validatePlan`. |
| **stats** | Preview-only per-table counters (`unchanged`, `lowConfidence`) — not stored in `changeSet`. |
| **movement** | Derived at read time: `changeSet.insert.length`, `.update.length`, `.delete.length`. Use `movementOfTable()` / `computePlanTotals()`. |
| **scope predicate** | Per-table `WHERE` fragment from the published definition (with `{id}` substituted). Defines **which rows** participate in hash diff on source and on target separately. |
| **hash diff** | Compare scoped rows via `fetchPkHash`: PK + `HASHBYTES('SHA2_256', …)` fingerprint per row. Not column-by-column diff in app code. |
| **in-memory PK join** | After two `fetchPkHash` calls, Node builds `Map<pk, row>` per side and classifies insert/update/delete/unchanged — logical full outer join on PK, **not** SQL `JOIN` across databases. |
| **fetchPkColumns** | Discovers PK column names (`sys.indexes`) before hash queries. Without PK metadata the engine cannot match rows or build `changeSet`. |
| **Data movement scope** | `dataMovementTables(plan)` — tables with changeSet insert/update PKs that run MERGE. |
| **Constraint relaxation scope** | `constraintRelaxationTables(plan)` — ancestors that get FK NOCHECK/CHECK; independent from data movement. |
| **Flow** | Named ordered step list in sync metadata. Include exactly one `metadataSync` step. |
| **Flow reference** | Entity run binding: `flowTemplateId` + service + environment. |
| **Step type** | Handler/action (`metadataSync`, `contractDeployEtl`, …). Defines what code runs and failure mode. |
| **Execution region** | Derived from position vs `metadataSync`: before (pre-tx), metadata (single SQL tx), after (deploy/HTTP). Not a separate catalog. |

## Compilers (all use `projectTablePredicate`)

| Function | When | Output |
|----------|------|--------|
| `scaffoldSyncDefinition` | Export draft from entity registry | `AuthoredSyncDefinition` |
| `compilePublishedSyncDefinition` | Publish from DB | `PublishedSyncDefinition` |

## Runtime table selection

`selectDefinitionTables(definition, enabledOptionalTables)` filters optional FK-only tables before diff/execute. User-controllable tables default off unless explicitly enabled.

| Concept | Doc |
|---------|-----|
| Hash diff, scoped rows, in-memory PK join | [SYNC-MECHANICS.md §2–8](./SYNC-MECHANICS.md) |
| Preview/execute orchestration, SQL labels | [SYNC-PREVIEW-EXECUTE.md](./SYNC-PREVIEW-EXECUTE.md) |

## Naming and value sources

| Layer | Convention | Examples |
|-------|------------|----------|
| SQLite columns | `snake_case` | `definition_json`, `built_in` |
| JSON keys, TS properties, catalog ids | `camelCase` | `metadataSync`, `entityId`, `objectName` |
| Human labels | free text | `"Metadata sync"`, `"Plan entity id"` |

**Handler inputs** answer one question: where does this value come from? The answer is always a typed `ValueSource` (in `@mia/shared-types`), not a string grammar.

| `ValueSource.type` | Meaning |
|--------------------|---------|
| `planEntityId` | Numeric id of the entity being synced |
| `planActor` | UPN of the user who started the run |
| `currentStepId` | `step.id` of the step currently executing |
| `contractName` / `ruleInputDatasetId` / `contractPipelineId` | Built-in target SQL lookups (embedded in code) |
| `stepField` | Reads `objectName`, `auditObjectType`, or `pipelineName` on the flow step instance |
| `priorOutput` | Named output from an earlier step in this flow |
| `literal` | Fixed constant on the handler slot |
| `catalog` | Operator-defined custom SQL lookup (stored in `customValueSources`) |

**Handler slot model:**

- **Kind-fixed** — `source` on the handler slot (`{ name, source }`)
- **Step-bound** — slot has `name` only; value comes from `step.bindings[name]`
- **Literal** — `source: { type: "literal", value }`

The **custom value source catalog** (`sync_run_binding_sources` in SQLite) holds operator-defined target-sql lookups only. Builtins are `ValueSource` enum variants, not catalog rows. There is no separate step-field catalog — step fields are properties on `AuthoredSyncFlowStep`.
