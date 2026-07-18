# Sync model — terminology

One-page glossary for how sync concepts relate in code.

## Authority chain

```
Catalog (SQLite)         — entities + flows + actions + sources + environments + run pointers
        ↓ Publish (assemble)
SyncDefinitions (SQLite) — one process JSON per entity (same shape preview uses)
        ↓ preview / execute
Three execution regions  — before metadataSync | metadataSync (SQL tx) | after metadataSync
```

**One rule:** entities **reference** a flow. Steps run in **array order**; `metadataSync` is the split point.  
**One definition:** Publish writes SyncDefinitions to SQLite — not a file in the repo. Export is optional download.

## Terms

| Term | Meaning |
|------|---------|
| **Catalog** | Editable sync config in SQLite (entities, flows, actions, sources, environments, strategies, run pointers, phases) + tip versions. |
| **Entity registry** | Versioned DB records (`EntityDefinition`): root table, dependent tables, scope per table, policies. |
| **SyncDefinition** | Full operational contract used by preview/execute: structure + governance + bindings + execution flow (+ publish stamps). Stored in `sync_definitions`. |
| **Authored sync definition** | Same process JSON without requiring publish stamps; also Format A git seeds under `deploy/sync/artifacts/entities/`. |
| **Entity registry export** | UI/DB shape (`EntityDefinition` + optional `run` bindings). Bulk file: `entity-registry.json`. Also called **Format B**. See [ARTIFACT-FORMATS.md](../../deploy/sync/ARTIFACT-FORMATS.md). |
| **Published sync definition** | SyncDefinition after Publish (`publishedAt` / `publishedVersion`). **Runtime authority** in SQLite. |
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
| **Flow** | Named ordered step list (`sync_flows` / seed `flows`). Include exactly one `metadataSync` step. |
| **Action** | Reusable step handler (`sync_actions` / seed `actions`). Defines what code runs and failure mode. |
| **Source** | Value-source catalog entry (`sync_value_sources` / seed `valueSources`) — where a handler input comes from. |
| **Flow reference** | Entity run binding: which flow + service + environment policy. |
| **Execution region** | Derived from position vs `metadataSync`: before (pre-tx), metadata (single SQL tx), after (deploy/HTTP). Not a separate catalog. |

## Compilers (all use `projectTablePredicate`)

Format A ↔ Format B conversion is documented in [deploy/sync/ARTIFACT-FORMATS.md](../../deploy/sync/ARTIFACT-FORMATS.md).

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

The **value source catalog** (`sync_run_binding_sources` in SQLite) holds every resolver — plan context, target SQL, and step text fields. Built-ins are seeded from `deploy/sync/artifacts/sync-metadata.json` (`built_in = 1`); operators may add entries or edit labels/descriptions. Handler slots reference catalog ids via `{ type: "catalog", id }`. Literals and prior-step outputs stay inline on the handler slot.
