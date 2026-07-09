# Sync mechanics

How `@mia/sync` compares two SQL Server databases and decides what to change.

**Scope:** MSSQL only. Two separate connection pools — one per environment (e.g. `dev`, `uat`, `prod`). No linked servers. Source and target are queried independently; comparison happens in application code.

**Deep dive:** [SYNC-PREVIEW-EXECUTE.md](./SYNC-PREVIEW-EXECUTE.md) — orchestration, log labels, plan persistence, execute transaction.  
**Terms:** [SYNC-MODEL.md](./SYNC-MODEL.md) — glossary.

---

## 1. What is being synced

A sync always targets **one entity instance** in **one direction** (source → target).

An **entity** (contract, dataset, rule, pipeline activity, gate metadata, content, …) is defined by a **published sync definition**, which includes:

- A list of tables (`core.Contract`, `core.Pipeline`, …)
- A **scope predicate** per table — restricts which rows belong to this entity instance
- Execution order (FK dependencies) and optional post-metadata flow steps

Published definitions live in `sync-definitions/published/definitions.bundle.json`. Preview/execute read them directly. Optional tables are filtered via `selectDefinitionTables()`.

**Preview never scans whole databases.** For each recipe table it only reads rows matching that table’s instantiated predicate (e.g. `contractId = 2545`, or an `EXISTS (…)` closure for child tables). The **same diff pipeline** runs for every entity type; only the table list, predicates, and flow template differ.

---

## 2. Unified preview pipeline (all entities)

The following applies identically to **contract**, **dataset**, **rule**, and every other published definition. Entity-specific behavior is limited to *which tables* and *which `WHERE` clauses* — not *how* comparison works.

```
┌─────────────────────────────────────────────────────────────────────────┐
│ PREVIEW (read-only on source + target)                                   │
├─────────────────────────────────────────────────────────────────────────┤
│ 0. Load published definition + instantiate scope predicates per table   │
│ 1. Catalog drift — schemas must match for recipe tables                  │
│ 2. fetchPkColumns — PK column names per table (sys.indexes, source)      │
│ 3. Per table (parallel): diffTable()                                     │
│    a. fetchTableColumns — which columns feed the content hash            │
│    b. fetchPkHash(source) — (pk, rowHash) for every row IN SCOPE        │
│    c. fetchPkHash(target) — same query shape on target                   │
│    d. Classify in Node — in-memory full-outer-join on PK (no SQL JOIN)  │
│    e. Optional: scope-conflict probe, UI sample SELECTs                    │
│    f. buildChangeSet — insert/update/delete PK lists → plan              │
│ 4. Assemble SyncPlan, savePlan                                           │
└─────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────┐
│ EXECUTE (writes target only)                                             │
│ Apply plan.tables[].changeSet only — no re-diff, no scope-wide SELECT *    │
└─────────────────────────────────────────────────────────────────────────┘
```

**Live Logs labels** map to these steps: `fetchPkColumns`, `fetchTableColumns`, `fetchPkHash` (twice per table — source and target share the same label), `detectScopeMisattribution`, `fetchSamples`, etc. See [SYNC-PREVIEW-EXECUTE.md §3](./SYNC-PREVIEW-EXECUTE.md).

---

## 3. Which rows are compared?

For **one table** in **one preview**, the row set is:

> All rows on that table where the table’s **scope predicate** is true, evaluated separately on source and on target.

The predicate comes from the published definition template with `{id}` (and sometimes `{ids}`) replaced by the entity instance you picked in the UI.

| Entity | Table example | Predicate shape (simplified) |
|--------|---------------|------------------------------|
| Contract | `core.Contract` | `contractId = 2545` |
| Contract | `core.Pipeline` | `contractId = 2545` |
| Contract | `core.Activity` | `EXISTS (… pipeline for this contract …)` |
| Dataset | `core.Dataset` | `datasetId = 792` |
| Rule | `core.Rule` | `inputDatasetId = …` |

So when we say “join rows by PK”, we mean: **within that scoped row set on source and that scoped row set on target**, pair up rows that share the same primary key value(s). Rows outside the predicate are invisible to this preview.

---

## 4. Why primary key metadata comes first (`fetchPkColumns`)

Before any hash query runs, preview discovers **which column(s) form the primary key** for each recipe table (query against `sys.indexes` on **source**).

PK metadata is required because:

1. **Identity** — Each compared row is addressed by its PK. The hash query `SELECT`s PK columns plus `rowHash`. Composite PKs become a single string key in code (e.g. `"1|42"` from `contractId` + `lineNo`).
2. **Matching** — Classification pairs source rows to target rows **only** when PK values match. Without PK names, the engine cannot build `pk` / `pkValues` or the `changeSet` entries execute uses in `WHERE pk IN (…)`.
3. **changeSet** — Execute applies `MERGE` / `DELETE` for explicit PK lists from preview. No PK → table is skipped with a warning.

PK columns are **not** included in the content hash (identity columns are excluded from `hashColumns`). PK is the **join key**; hash is the **equality test for payload**.

---

## 5. Step 0 — catalog check (schema)

Before comparing data, the engine checks that source and target **schemas match** for the tables in the recipe.

It reads `INFORMATION_SCHEMA.COLUMNS` on both sides and reports:

- table missing on source or target
- column missing on target
- column type mismatch

If catalog is incompatible, preview warns and execute refuses. Row diff is meaningless when columns differ.

---

## 6. Step 1 — discover hash input columns (`fetchTableColumns`)

For each recipe table, the engine reads `sys.columns` on the **source** and builds the column set used for the fingerprint:

| Included in hash | Excluded |
|---|---|
| Regular data columns | **Primary key (identity)** — used only for matching, not hashed |
| | Computed columns |
| | `validFrom`, `validTo`, `isLocked`, `syncDate`, `deployDate` |

This mirrors legacy `uspSyncObjectTran`: compare business payload, not SCD/audit metadata.

---

## 7. Step 2 — row fingerprint (`fetchPkHash`, twice per table)

For each table, **source** and **target** each run one query of the same shape (in parallel):

```sql
SELECT [pkCol1], [pkCol2], …,
       HASHBYTES('SHA2_256', ISNULL(CONCAT_WS('|', <canonical col1>, <canonical col2>, …), '')) AS rowHash
FROM [schema].[table]
WHERE <scope predicate for this entity>
```

**Output per row:** `{ pk, rowHash, pkValues }` where `pk` is a string built from PK column values (composite keys joined with `|`).

**Not** a join between source and target in SQL. Each side returns a flat list of scoped rows. Comparison happens next in Node.

### Canonical values (why hashes are stable)

Each column type is converted to a fixed string form before hashing (ISO dates, full-precision floats, hex for binary, etc.). Session options (`LANGUAGE us_english`, `DATEFORMAT ymd`, …) are set on every query so two servers with different defaults still produce the same hash for the same data. NULLs flow through `CONCAT_WS` consistently on both sides.

---

## 8. Step 3 — classify in Node (in-memory join, not SQL)

After both `fetchPkHash` calls return, `diffTable()` in `diff-engine/index.ts` builds two maps:

```typescript
srcByPk = Map<pkString, { pk, rowHash, pkValues }>  // from source
tgtByPk = Map<pkString, { pk, rowHash, pkValues }>  // from target
```

Classification is the **logical equivalent of a full outer join on PK**, implemented as two loops in TypeScript — **no** `JOIN` between source and target databases and **no** linked server.

```
For each pk in source map:
  if pk not in target map     → INSERT   (on source only)
  if pk in both, same hash    → UNCHANGED
  if pk in both, different hash → UPDATE

For each pk in target map:
  if pk not in source map     → DELETE   (on target only)
```

| In source map? | In target map? | `rowHash` equal? | Bucket |
|----------------|----------------|------------------|--------|
| yes | no | — | **insert** |
| yes | yes | yes | **unchanged** (count only; not in changeSet) |
| yes | yes | no | **update** |
| no | yes | — | **delete** |

**ID locates the row; hash decides if the payload changed.** Column-by-column diff is not done in app code — inequality of hash implies UPDATE.

### Optional: scope misattribution (`conflicts`)

The scoped diff can label a row **insert** (PK absent in target *within the predicate*). A separate probe asks: does that PK exist on target **anywhere** under a different parent? If yes → `conflicts` (blocks execute). See [SYNC-PREVIEW-EXECUTE.md §3.4 Phase E](./SYNC-PREVIEW-EXECUTE.md).

### Output: `changeSet`

```typescript
changeSet: {
  insert: [{ pk: "99", values: { pipelineId: 99, contractId: 2545 } }],
  update: […],
  delete: […]
}
```

Built by `buildChangeSet()`. **Execute reads only these PK lists** — see §10.

---

## 9. Step 4 — preview output (`SyncPlan`)

`previewSync` runs the diff for every recipe table (in parallel), then stores a **SyncPlan**:

- per table: **`changeSet`** — full PK lists per insert/update/delete bucket (execute authority)
- **`stats`** — preview-only `unchanged` / `lowConfidence` (not in `changeSet`)
- **samples** — UI decoration only; execute ignores
- scope predicate (frozen at preview), warnings (row cap, scope conflicts, …)

Movement counts (`insert` / `update` / `delete`) are **never stored** on the table — derive with `movementOfTable(table)` or aggregate via `computePlanTotals(plan.tables)`. `plan.totals` is written at preview time and checked by `validatePlan`.

The plan is an immutable contract for execute. TTL ~1 hour. `savePlan` and `executeSync` both call `validatePlan` (changeSet present; totals match derived counts).

**Details:** [SYNC-PREVIEW-EXECUTE.md §3–5](./SYNC-PREVIEW-EXECUTE.md).

---

## 10. Step 5 — execute

`executeSync` applies the saved plan's **changeSet** on the target — no re-diff, no scope-wide reads:

- **INSERT / UPDATE:** `SELECT *` from source **only for changeSet PKs**, stage in temp table, **MERGE** into target
- **DELETE:** `DELETE` on target **only for changeSet delete PKs**
- Meta columns (`validFrom`, `validTo`, …) are not copied — set explicitly like legacy `uspSyncObjectTran`

**Table participation** (two independent rules):

| Rule | Function | Meaning |
|------|----------|---------|
| Data movement | `dataMovementTables` | Tables with changeSet insert/update PKs get MERGE |
| FK relaxation | `constraintRelaxationTables` | Ancestors through deepest changeSet op get NOCHECK/CHECK |

Safety gates before apply: catalog drift, `validatePlan`, freeze windows.

All metadata writes run in one transaction (`runMetadataSync`).

**Details:** [SYNC-PREVIEW-EXECUTE.md §6](./SYNC-PREVIEW-EXECUTE.md).

---

## 11. Mental model

```
SyncPlan     = envelope (entity, envs, executionContract, tables[], warnings)
changeSet    = per-table execute instructions (insert/update/delete PK lists)
movement     = derived from changeSet lengths (movementOfTable / computePlanTotals)
stats        = preview-only unchanged / lowConfidence
conflicts    = scope misattribution array; length blocks execute
Preview      = diff → SyncPlan
Execute      = apply changeSet on target (O(changes) I/O)
```

**Preview computes once; execute reads `changeSet` only.**

**Not** a generic replication engine. **Not** timestamp-based. **Not** log shipping.

It is deterministic, scoped, PK-keyed, hash-based reconciliation of ABI metadata rows between two SQL Server instances.

### Quick answers

| Question | Answer |
|----------|--------|
| Which rows? | Rows matching each table’s **scope predicate** for the chosen entity instance, on source and on target separately. |
| What is “join by PK”? | **In-memory** pairing of those two lists by primary key string — not a SQL `JOIN` across servers. |
| Why `fetchPkColumns` first? | PK columns name the join key and populate `changeSet` for execute. |
| Why two `fetchPkHash` per table? | One query on **source**, one on **target** (same label in logs). |
| Same for dataset as contract? | **Yes** — same pipeline; definition supplies tables + predicates + flow only. |
