# Sync mechanics

How `@mia/sync` compares two SQL Server databases and decides what to change.

**Scope:** MSSQL only. Two separate connection pools — one per environment (e.g. `dev`, `uat`, `prod`). No linked servers. Source and target are queried independently; comparison happens in application code.

---

## 1. What is being synced

A sync always targets **one entity instance** in **one direction** (source → target).

An **entity** (contract, dataset, rule, …) is defined by a **recipe**:

- A list of tables (`core.Contract`, `core.ContractColumn`, …)
- A **scope predicate** per table — restricts rows to that entity, e.g. `contractId = 2545`
- Execution order (FK dependencies)

The recipe comes from published sync definitions. Preview/execute never scan whole databases — only the tables and rows in scope for that entity.

---

## 2. Step 0 — catalog check (schema)

Before comparing data, the engine checks that source and target **schemas match** for the tables in the recipe.

It reads `INFORMATION_SCHEMA.COLUMNS` on both sides and reports:

- table missing on source or target
- column missing on target
- column type mismatch

If catalog is incompatible, preview warns and execute refuses. Row diff is meaningless when columns differ.

---

## 3. Step 1 — discover columns per table

For each recipe table, the engine reads `sys.columns` on the **source** and builds the column set used for comparison:

| Included in hash | Excluded |
|---|---|
| Regular data columns | Primary key (identity) — used only for matching |
| | Computed columns |
| | `validFrom`, `validTo`, `isLocked`, `syncDate`, `deployDate` |

PK columns come from `sys.indexes` where `is_primary_key = 1`.

---

## 4. Step 2 — row fingerprint (the core mechanic)

For each table, both databases run the same SQL shape:

```sql
SELECT [pkCol1], [pkCol2], …,
       HASHBYTES('SHA2_256', ISNULL(CONCAT_WS('|', <canonical col1>, <canonical col2>, …), '')) AS rowHash
FROM [schema].[table]
WHERE <scope predicate>
```

### How rows are matched

**By primary key.** Each row is keyed by its PK value(s). Source and target maps are outer-joined on PK.

### How sameness is decided

**By content hash, not by comparing column-by-column in app code.**

For each PK:

| Source | Target | Hash match | Result |
|---|---|---|---|
| present | absent | — | **INSERT** |
| present | present | same | **UNCHANGED** |
| present | present | different | **UPDATE** |
| absent | present | — | **DELETE** |

So: **ID locates the row; hash tells you if the payload changed.**

### Canonical values (why hashes are stable)

Each column type is converted to a fixed string form before hashing (ISO dates, full-precision floats, hex for binary, etc.). Session options (`LANGUAGE us_english`, `DATEFORMAT ymd`, …) are set on every query so two servers with different defaults still produce the same hash for the same data.

NULLs flow through `CONCAT_WS` consistently on both sides.

---

## 5. Step 3 — preview output

`previewSync` runs the diff for every recipe table (in parallel), then stores a **SyncPlan**:

- per table: counts of insert / update / delete / unchanged
- sample rows per bucket (for human review)
- scope predicate, PK columns, warnings (row cap, scope conflicts, …)

The plan is immutable reference for execute. TTL ~1 hour.

---

## 6. Step 4 — execute

`executeSync` applies the saved plan to the **target** only:

- **INSERT / UPDATE:** read full rows from source, stage in temp table, **MERGE** into target
- **DELETE:** delete target rows by PK
- Meta columns (`validFrom`, `validTo`, …) are not copied — set explicitly (`validFrom = GETUTCDATE()`, `validTo = NULL`) like the legacy `uspSyncObjectTran` procs

Safety gates before apply:

- catalog drift re-check
- source row-count drift re-check (abort if source moved >5% since preview)
- freeze windows / policy

All writes run in a transaction per table batch.

---

## 7. Mental model

```
Environments     = named MSSQL connections (two servers, two pools)
Entity + recipe  = which tables, which rows (predicate)
Catalog check    = do the columns exist and match?
Row diff         = PK match + SHA2_256 content hash
Preview          = plan (what would change)
Execute          = MERGE/DELETE on target to match source
```

**Not** a generic replication engine. **Not** timestamp-based. **Not** log shipping.

It is deterministic, scoped, PK-keyed, hash-based reconciliation of ABI metadata rows between two SQL Server instances.
