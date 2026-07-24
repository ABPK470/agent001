# ABI Environment Sync — System Reference

How cross-environment **ABI metadata** synchronization works in this product:
concepts, authority chain, preview vs execute, governance, and how operators
and the agent reach it.

Companion docs:

| Doc | Focus |
| --- | --- |
| [packages/sync/SYNC-MODEL.md](packages/sync/SYNC-MODEL.md) | Terminology |
| [packages/sync/SYNC-MECHANICS.md](packages/sync/SYNC-MECHANICS.md) | How rows are compared |
| [packages/sync/SYNC-PREVIEW-EXECUTE.md](packages/sync/SYNC-PREVIEW-EXECUTE.md) | Preview → plan → execute contract |

---

## 1. Concepts

### Entity

One logical ABI metadata object — for example a Contract, Dataset, Rule,
Pipeline activity, Gate meta table, or Content item.

Identified by:

| Field | Meaning |
| --- | --- |
| `entityType` | Published definition id (e.g. `contract`, `gateMetadata`) |
| `entityId` | Primary key of the root table row in the **source** environment |

Users may refer to entities by display name or numeric id. Name resolution
searches the root table’s label column on the source environment.

### Environment

A named MSSQL connection with sync policy: source / target / both, allowed
directions, service URLs for post-metadata callbacks, and access mode.
Examples: `dev`, `uat`, `prod`.

Sync always moves metadata **source → target**. Source and target must differ;
direction must be allowed by policy.

### Catalog → Publish → Definition

| Layer | Role |
| --- | --- |
| **Catalog** | Editable authoring truth in SQLite — entities, flows, actions, value sources, environments, strategies |
| **Publish** | Compiles catalog into immutable **SyncDefinitions** used at runtime |
| **SyncDefinition** | Operational contract: root table, table closure + scope predicates, execution order, governance, flow steps |

Preview and execute read **published** definitions only. Editing the catalog
does not change runtime until publish. Tip ahead of published contract blocks
preview/execute until operators publish.

### Recipe / table closure

A definition projects to a table list with per-table **scope predicates**
(`{id}` / `{ids}` placeholders), parent→child execution order, child→parent
delete order, optional FK-only tables, and post-metadata flow steps.

Optional tables default off; callers may enable them explicitly. Selection is
frozen into the plan.

### SyncPlan

Durable output of **preview**: per-table change classification, samples,
warnings, frozen **execution contract**, governance snapshot, and the
per-table **changeSet** (insert / update / delete PK lists) that execute will
apply. Execute references the plan by id — it does not re-derive scope from
raw user input.

### Preview vs execute

| Phase | Purpose | Mutates target? |
| --- | --- | --- |
| **Preview** | Classify differences, surface conflicts, freeze contract | No |
| **Execute** | Apply changeSet + run post-metadata steps | Yes |

Preview is always required before execute. Agent and UI enforce preview-first
workflows.

---

## 2. Architecture

```text
UI · Agent tools · REST
        │
        ▼
   @mia/server (composition: pools, environments, plan store, run sink, SSE)
        │
        ▼
   @mia/sync
     runtime  — preview, execute, plan store, events
     core     — compile, eligibility, flow, intent, governance decisions
     domain   — vocabulary, plan shapes, governance types
     tools    — sync_preview, sync_execute, search, catalogs, …
     adapters — MSSQL pools, HTTP
```

`@mia/sync` does not depend on `@mia/agent`. The server wires both. Sync is
MSSQL-specific by design.

---

## 3. Prerequisites

Before preview can succeed:

1. MSSQL connections registered for the environments involved
2. Environment registry populated (SQLite admin, deploy defaults, or synthesis
   from connections)
3. Entity definitions authored in the catalog
4. Definitions **published**
5. Plan store available under the data directory
6. Freeze-window registry installed when governance uses freeze windows

Until publish completes for an entity type, runtime refuses unknown types.

---

## 4. Preview (conceptual)

Given entity type, instance id, source, and target:

1. Load published definition; select tables (including optional opt-ins)
2. Validate environments, direction, and soft governance signals
3. Expand tree ids when the root uses a self-join (hierarchical entities)
4. Check catalog drift between source and target for recipe tables
5. Diff each table under its scope predicate (hash-based; see mechanics doc)
6. Detect scope misattribution conflicts
7. Assemble and persist a SyncPlan with execution contract and changeSets

Hard failures (missing definition, illegal direction, …) abort. Soft signals
(catalog drift, freeze windows) warn on preview and harden on execute.

Plans expire for execute after a short TTL (re-preview required). Disk retention
is longer for history.

---

## 5. Execute (conceptual)

Given a plan id and explicit confirmation:

1. Load plan; refuse if missing, stale, invalid, or conflicted
2. Re-check environments, catalog drift, freeze windows, and policy
3. Run the frozen flow in order, in three bands:

| Band | Role | Failure boundary |
| --- | --- | --- |
| **Pre-transaction** | Audit / lock style steps | Warnings; flow continues |
| **Metadata** | Single SQL transaction — MERGE/DELETE from changeSet | Rollback of metadata; execute aborts |
| **Post-metadata** | Deploy sprocs, ETL/Agent/Gate HTTP, dates, unlock | Per-step warnings; **metadata already committed** |

“Single transaction with rollback” applies **only** to the metadata band.
Post-metadata side effects are not rolled back with metadata. A failed deploy
step can leave the target in a partially deployed state that needs operator
follow-up.

---

## 6. Diff model (summary)

For each recipe table, preview reads scoped rows on source and target
independently, fingerprints business columns with a deterministic hash,
classifies insert / update / delete / unchanged by primary key in process
memory, and stores PK lists in `changeSet`. Execute applies only those PKs —
no re-diff, no scope-wide table scans.

Scope misattribution (PK exists on target under a different parent) is a
**conflict**: counted at preview, hard block at execute.

Full detail: [SYNC-MECHANICS.md](packages/sync/SYNC-MECHANICS.md).

---

## 7. Governance and safety

| Control | Behavior |
| --- | --- |
| **Policies** | Allow / deny / require approval for `sync_preview` and `sync_execute` (HTTP and agent). Default deny. Admin edits policy; does not bypass it. |
| **Freeze windows** | Soft at preview; hard at execute unless audited override |
| **Catalog drift** | Soft at preview; hard at execute |
| **Conflicts** | Hard at execute |
| **Plan age** | Execute refuses stale plans |
| **Publish readiness** | Tip ahead of published contract → publish required |
| **Environment roles** | Source/target roles and allowed directions |

Environments describe topology and service URLs. They are not a second policy
system.

---

## 8. Agent and UI

**Tools:** list environments, search entities, compare catalogs, sync preview,
sync execute (requires explicit confirm), related scope/diff helpers.

**Chat doctrine:** preview-first; stop after preview; execute only on a separate
explicit confirmation; numeric id → preview directly; display name → search
then preview; never use generic catalog search for entity instance lookup.

**REST:** environments, definitions publish, search, preview, plan load,
execute (+ progress stream), history/runs, entity registry and freeze-window
admin surfaces.

**Events:** preview/execute lifecycle events over the shared SSE stream; run
history via the sync run sink into SQLite.

---

## 9. Operator workflows

**Manual (Env Sync):** pick source/target → entity type → resolve instance →
optional tables → preview → review totals/samples/conflicts → confirm execute.

**Agent-driven:** state goal with type, instance, and route → preview → stop →
user confirms → execute with confirm.

**Conflicts:** do not execute; fix target parent/scope; re-preview.

**Catalog drift:** align schemas; re-preview; execute refuses until compatible.

**Post-metadata failure:** metadata may already be live; inspect step warnings
and service URLs; repair and re-run deploy steps as needed.

**Definition changes:** edit catalog → publish → new previews use the new
contract; existing plans keep the old frozen contract until re-previewed.
