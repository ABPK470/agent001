# Sync mechanics

How `@mia/sync` compares two SQL Server databases and decides what to change.

**Scope:** MSSQL only. Separate connection pools per environment. No linked
servers. Source and target are queried independently; comparison happens in
the application.

**Companions:** [SYNC-PREVIEW-EXECUTE.md](./SYNC-PREVIEW-EXECUTE.md) ·
[SYNC-MODEL.md](./SYNC-MODEL.md)

---

## 1. What is being synced

A sync always targets **one entity instance** in **one direction**
(source → target).

The published sync definition supplies:

- Which tables participate
- A **scope predicate** per table (which rows belong to this instance)
- Execution order (FK dependencies)
- Optional post-metadata flow steps

**Preview never scans whole databases.** For each table it only considers rows
matching that table’s instantiated predicate. The **same diff pipeline** runs
for every entity type; only tables, predicates, and flow differ.

---

## 2. Pipeline

```text
PREVIEW (read-only on source + target)
  0. Load published definition · instantiate scope predicates
  1. Catalog drift — schemas must match for recipe tables
  2. Discover primary-key columns per table (source)
  3. Per table (parallel):
       a. Choose hash input columns (exclude identity, computed, SCD/audit meta)
       b. Fingerprint scoped rows on source
       c. Fingerprint scoped rows on target
       d. Classify in memory by PK (insert / update / delete / unchanged)
       e. Probe scope conflicts on insert candidates
       f. Build changeSet (PK lists) + samples for UI
  4. Assemble SyncPlan · persist

EXECUTE (writes target)
  Apply plan.tables[].changeSet only — no re-diff, no scope-wide SELECT *
```

---

## 3. Which rows are compared?

For one table in one preview:

> All rows where the table’s **scope predicate** is true, evaluated separately
> on source and on target.

The predicate comes from the published definition with `{id}` (and sometimes
`{ids}`) replaced by the chosen entity instance. Hierarchical entities expand
`{ids}` via a tree walk on source.

Rows outside the predicate are invisible to this preview.

---

## 4. Why primary keys come first

PK columns are discovered before any hash query because:

1. **Identity** — each compared row is addressed by its PK
2. **Matching** — source and target rows pair only when PK values match
3. **changeSet** — execute applies MERGE / DELETE for explicit PK lists

PK is the join key. Hash is the equality test for business payload. Identity
and SCD/audit meta columns are excluded from the hash.

---

## 5. Catalog check

Before comparing data, source and target schemas are checked for recipe tables
(table presence, columns, types). Incompatible catalog → preview warning;
execute refuses. Row diff is meaningless when columns differ.

---

## 6. Row fingerprint

For each table, source and target each produce a list of `{ pk, rowHash }` for
scoped rows. Values are canonicalized so two servers with different session
defaults still agree. Comparison is **not** a SQL join across environments.

---

## 7. Classification (in memory)

Logical full outer join on primary key:

| In source? | In target? | Hash equal? | Bucket |
| --- | --- | --- | --- |
| yes | no | — | **insert** |
| yes | yes | yes | **unchanged** |
| yes | yes | no | **update** |
| no | yes | — | **delete** |

**ID locates the row; hash decides if the payload changed.** Column-by-column
diff is not performed in application code.

### Conflicts (block execute — not changeSet ownership)

Two probes look **outside** scoped changeSet work and write `conflicts`:

| Kind | When |
| --- | --- |
| **Scope misattribution** | Insert PK already exists on target under a different parent |
| **Inbound reference** | Delete PK still referenced by a row this plan does not own (e.g. Right-side mapping columns) |

Inbound hits whose referencing row is already in this plan’s `changeSet.delete`
are ignored (reverseOrder will remove them). Remaining hits demote those deletes
out of `changeSet` and block execute until the owning metadata is fixed.

### changeSet

```text
changeSet = {
  insert: [ { pk, values }, … ],
  update: [ … ],
  delete: [ … ]
}
```

Execute reads **only** these PK lists. Samples and unchanged counts are
preview/UI decoration.

---

## 8. Execute (apply)

Execute applies the saved changeSet on the target:

- **INSERT / UPDATE** — read those PKs from source, MERGE into target
- **DELETE** — delete those PKs on target
- Meta columns (`validFrom`, `validTo`, …) are set explicitly, not copied

Two independent scopes:

| Concern | Meaning |
| --- | --- |
| **Data movement** | Tables with changeSet insert/update PKs get MERGE |
| **Constraint relaxation** | Ancestors through deepest changeSet op may get FK NOCHECK/CHECK |

All metadata writes for the entity run in **one** target transaction. Safety
gates (catalog, conflicts, plan validation, freeze windows) run before apply.

---

## 9. Mental model

```text
SyncPlan   = envelope (entity, envs, executionContract, tables[], warnings)
changeSet  = per-table execute instructions (insert/update/delete PK lists)
movement   = derived from changeSet lengths
stats      = preview-only unchanged / lowConfidence
conflicts  = scope misattribution; length blocks execute
Preview    = diff → SyncPlan
Execute    = apply changeSet on target (I/O proportional to changes)
```

**Preview computes once; execute reads `changeSet` only.**

Not generic replication. Not timestamp-based. Not log shipping.

Deterministic, scoped, PK-keyed, hash-based reconciliation of ABI metadata
rows between two SQL Server instances.
