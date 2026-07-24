# Sync preview & execute

How `@mia/sync` builds a **SyncPlan**, what that plan means, and how execute
turns it into writes on the target.

**Companions:** [SYNC-MECHANICS.md](./SYNC-MECHANICS.md) ·
[SYNC-MODEL.md](./SYNC-MODEL.md) · [sync-system.md](../../sync-system.md)

**Scope:** MSSQL. The orchestration contract is engine-agnostic; the current
SQL dialect and post-metadata pipeline are not.

---

## 1. End-to-end

```text
Preview  →  classify rows · build SyncPlan + changeSet · persist
Execute  →  load plan · gates · pre-tx steps · metadata transaction · post steps
```

**Key idea:** Preview classifies rows and persists a SyncPlan whose per-table
**changeSet** lists every PK to insert, update, or delete. Execute applies
**only those PKs** — no re-diff, no scope-wide reads.

**Publish gate:** Preview and execute require the published contract to match
the catalog tip. Tip ahead of published → publish required before work proceeds.

HTTP and agent tools share the same orchestrator.

---

## 2. Who calls what

| Entry | Effect |
| --- | --- |
| HTTP preview / execute | Product API → `previewSync` / `executeSync` |
| Agent tools | Same orchestrator behind sync tools |
| Plan load | Read persisted SyncPlan by id |

Orchestration owns sequencing and gates. The diff engine owns comparison.
Adapters own pools. Operators never hand-write sync SQL.

---

## 3. Preview

### Inputs

| Field | Meaning |
| --- | --- |
| `entityType` | Published definition id |
| `entityId` | Instance primary key |
| `source` / `target` | Environment names |
| `enabledOptionalTables` | FK-closure tables opted in |
| Attribution | Actor for governance / audit |

### Steps

1. Load published definition; select tables; instantiate predicates
2. Expand tree ids when the root is hierarchical
3. Catalog drift check (both environments)
4. Discover PK columns; resolve display name
5. Per table — hash fingerprint source and target in parallel; classify in
   memory; probe conflicts; build changeSet; fetch UI samples
6. Assemble SyncPlan (totals, warnings, execution contract, governance
   snapshot); persist; emit lifecycle events

Optional tables excluded by default appear as warnings until enabled. A row
cap protects against unbounded hash reads; force mode lifts it for operators
who accept the cost.

---

## 4. The SyncPlan

Immutable contract for execute. JSON-serializable.

### Envelope

| Field | Purpose |
| --- | --- |
| `planId` | Identity everywhere |
| `entity` | Type, id, display name |
| `source` / `target` | Environments |
| `tables[]` | Per-table results + frozen scope predicate |
| `totals` | Aggregated movement + stats + conflicts |
| `executionContract` | Frozen definition metadata + flow steps |
| `preflight` / `warnings` / `decisionLog` | Drift, governance, explainability |
| Timestamps | TTL math |

### Per-table

| Field | Purpose |
| --- | --- |
| `changeSet` | Insert / update / delete PK lists — **execute authority** |
| `stats` | Unchanged / lowConfidence — preview only |
| `samples` | UI decoration — execute ignores |
| `conflicts` | Scope misattribution / inbound delete blockers — length blocks execute |

**Contract:** Execute applies exactly the rows in `changeSet`. Plans without a
valid changeSet cannot execute — re-preview.

| Concern | Driven by |
| --- | --- |
| Which rows to MERGE | `changeSet.insert` + `changeSet.update` |
| Which rows to DELETE | `changeSet.delete` |
| Which tables get MERGE | Tables with non-empty insert/update changeSet |
| Which tables get FK relaxation | Ancestors through deepest changeSet op |

FK relaxation and data movement are **independent**. Ancestors with zero
changeSet ops are not re-MERGED.

### Execution contract

Snapshotted at preview so a later publish cannot change what this plan runs:
definition identity, table list and orders, and the ordered flow steps
(including exactly one `metadataSync` split point).

---

## 5. Plan persistence

| Layer | Role |
| --- | --- |
| Memory | Fast path for the live process |
| Disk JSON | Short retention under the data directory |
| SQLite run sink | History and `plan_json` for audit UI |

Execute refuses plans older than the execute TTL. History reads run records,
not the raw event log.

---

## 6. Execute

### Gates (before any write)

- Explicit confirmation
- Plan exists, valid, within TTL
- Environment roles and direction
- Policy allow / deny / approval
- Catalog drift — hard refuse if incompatible
- Scope / inbound conflicts — hard refuse if any
- changeSet present; totals consistent with changeSets
- Freeze windows — hard refuse unless audited override

### Flow bands

Frozen `executionContract.flow.steps` run in order:

| Band | Typical steps | Transaction |
| --- | --- | --- |
| Pre-transaction | Audit, target lock | Outside metadata tx; failures warn |
| Metadata | `metadataSync` | **Single** target SQL transaction |
| Post-metadata | Deploy, HTTP callbacks, dates, unlock | Outside metadata tx; failures warn |

### Metadata transaction

1. Compute data-movement vs constraint-relaxation table sets from changeSet
2. Begin transaction; relax FKs on relaxation set
3. Upserts (execution order ∩ movement tables) — read source by changeSet PKs,
   MERGE into target; set SCD/audit meta explicitly
4. Deletes (reverse order) — delete changeSet delete PKs only
5. Re-enable FKs; commit

On failure: rollback metadata, best-effort restore constraints, abort before
post-metadata. Row I/O is proportional to changes, not to full scope size.

### Post-metadata

Entity-specific deploy and callback steps from the flow template. Each step is
isolated. Failures become step warnings; **committed metadata is not undone**.
Missing service URLs surface as warnings under the same model.

A run can finish Failed while metadata diffs are already live — partial deploy
state that may need manual follow-up.

### Run persistence

Start / finish (and preview) recorded through the sync run sink into SQLite
for history and audit.

---

## 7. Mental model

```text
Published definition  →  predicates + table order + flow steps
Preview               →  read both DBs · classify · write plan + changeSet
SyncPlan              →  envelope + per-table changeSet + executionContract
Execute metadata      →  read source by changeSet PK · write target in one tx
Execute post-steps    →  target sprocs / deploy actions (entity-specific)
```

| Question | Answer |
| --- | --- |
| What changed? | `changeSet` (movement = array lengths) |
| Which tables MERGE? | Tables with changeSet insert/update |
| Which tables toggle FK? | Ancestors through deepest change |
| How large is execute I/O? | Proportional to changes — never to full scope |

One algorithm: preview computes *what* changed; execute applies *exactly that*.
