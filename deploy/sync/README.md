# Sync deploy seeds

Bootstrap data for sync: rebuild **legacy MyMI pipelines** into mia **entity registry** + **sync metadata**, then seed SQLite on first boot.

**Not in this tree:** SQLite schema migrations live in `packages/server/src/platform/persistence/migrations/`.

## Why this exists

Legacy MyMI has **pipelines** and **activities** — not “entities”. “Entity” is a mia term we invented here.

| Legacy (MyMI / ABI) | Mia |
|---------------------|-----|
| `core.Pipeline` | sync **flow** (one per entity type) |
| `core.Activity` | flow **step** / **action** |
| `uspSync*ObjectsTran` entry activity | entity type + table scopes |
| `properties.sync` on an activity | step type handler definition |

These scripts **reconstruct** legacy ground truth into deploy artifacts. After first boot, operators manage everything in **Entity Registry** (full CRUD). Generators are for:

1. **Cold start** — ship reviewed seeds in git
2. **Refresh** — pull latest from live MyMI when MSSQL is available

## Authority model (one path)

```
Live MSSQL (optional)  →  refresh-from-legacy  →  deploy/sync/artifacts/*
                                                      ↓ server boot seed
                                                 SQLite (operator edits)
                                                      ↓ export (optional)
                                                 deploy/sync/artifacts/*  (review → commit)
                                                      ↓ publish
                              sync-definitions/published/definitions.bundle.json
                                                      ↓
                                               preview / execute
```

- **Shipped artifacts** — default for first boot when SQLite is empty.
- **Refresh from MSSQL** — on a deployed dev/UAT host with corp DB access, admins regenerate artifacts from ground truth, restart, then publish. UI: Policies → Platform → **Refresh from database**.
- **After boot** — SQLite is the source of truth for operator edits. Deploy artifacts **re-seed built-in rows** on every boot (`built_in=1`); custom rows are preserved.
- **Export** — write the current SQLite catalog back to JSON for versioning. CLI or `POST /api/platform/artifacts/export`.
- **Runtime execute** reads the **published bundle**, not deploy files directly.

Handler wiring always uses `{ "type": "catalog", "id": "…" }` — no legacy shorthand types in artifacts.

## Layout

| Path | Role |
|------|------|
| `generators/refresh-from-legacy.mjs` | **Only CLI** — rebuild all artifacts |
| `helpers/` | Derivation libraries (imported by generator + server API) |
| `artifacts/` | Shipped bootstrap JSON — or output of a live MSSQL refresh |
| `fixtures/` | Offline pipeline evidence for tests / offline generation |
| `sync-environments.json` | Environment registry seed |
| `entity-registry.seed.yaml` | Optional entity registry export (YAML) |

## Shipped artifacts

| File | SQLite tables | UI surface |
|------|---------------|------------|
| `artifacts/sync-metadata.json` | `sync_run_phases`, `sync_run_kinds`, `sync_run_binding_sources`, `sync_run_presets` | Configuration → Flows / Actions / Wiring |
| `artifacts/strategies.json` | `scd2_strategies`, `scd2_strategy_versions` | Entity Registry → Strategies |
| `artifacts/entities/*.json` | entity registry | Entity Registry |
| `sync-environments.json` | `sync_environments` | Policies → Environments |
| `artifacts/flow-templates.json` | (derived view of flows) | compile-time helper |

## Helpers (derivation only)

| Module | Purpose |
|--------|---------|
| `refresh-from-legacy.mjs` | Orchestrator — writes all artifact outputs |
| `legacy-pipeline-evidence.mjs` | Fetch `core.Pipeline` + `core.Activity` from MSSQL or fixture |
| `legacy-entity-derivation.mjs` | Pipeline → `artifacts/entities/*.json` (table scopes, predicates) |
| `sync-metadata-derivation.mjs` | Pipeline → `sync-metadata.json` (step types, flows, wiring) |
| `legacy-activity-sync-specs.mjs` | Build offline activity overlay fixture |
| `catalog-index.mjs` | MSSQL schema snapshot for entity FK closure |
| `sync-metadata-phases.mjs` | Fixed platform phase vocabulary |
| `sync-metadata-normalize.mjs` | Normalize handler slots to catalog refs |
| `value-source-seeds.mjs` | Shipped wiring catalog (plan context, SQL, step fields) |

No one-shot migration scripts — artifacts in git are already on the current model.

## Refresh from MSSQL

Run from **repo root** on a host with MSSQL configured in `.env`:

```sh
node deploy/sync/generators/refresh-from-legacy.mjs --connection uat --force
```

Writes:

| Output | Content |
|--------|---------|
| `artifacts/entities/*.json` | Entity definitions |
| `artifacts/sync-metadata.json` | Phases, step types, **wiring**, flows |
| `artifacts/flow-templates.json` | View of `sync-metadata.flows` |
| `fixtures/legacy-activity-sync-specs.json` | Offline `pipelineId:sequence` overlay |

Wiring (`customValueSources`) is included automatically via `sync-metadata-derivation.mjs` → `value-source-seeds.mjs`.

**On a running server:** Policies → Platform → **Refresh from database** runs the same helper, then re-imports into SQLite.

After refresh: restart server → review Entity Registry → **Publish**.

## Export from SQLite (snapshot — not repo overwrite)

After editing in the UI, export the live catalog to a **timestamped folder on your machine** (never overwrites `deploy/sync` seeds in the repo):

```sh
npm run export-deploy-catalog --workspace @mia/server
# default parent: ~/Downloads → ~/Downloads/mia-sync-export-2026-07-10T14-18-30/

npm run export-deploy-catalog --workspace @mia/server -- --output ~/Documents/mia-exports
npm run export-deploy-catalog --workspace @mia/server -- --zip
npm run export-deploy-catalog --workspace @mia/server -- --dry-run
```

**Folder contents** (mirrors `deploy/sync/` layout):

```
mia-sync-export-<timestamp>/
  manifest.json
  sync-environments.json
  artifacts/
    sync-metadata.json
    strategies.json
    flow-templates.json
    entity-registry.json
```

| Path | Source (SQLite) |
|------|-----------------|
| `manifest.json` | export metadata |
| `sync-environments.json` | environments |
| `artifacts/sync-metadata.json` | phases, actions, wiring, flows |
| `artifacts/strategies.json` | all SCD2 strategies |
| `artifacts/flow-templates.json` | flow template view |
| `artifacts/entity-registry.json` | entity definitions + run bindings |

Entities-only subset:

```sh
npm run entity-registry:export --workspace @mia/server -- --output ~/Downloads
```

API:
- `POST /api/platform/artifacts/export` — snapshot JSON (save client-side)
- `POST /api/platform/artifacts/export/download` — zip download (Entity Registry → **Export configuration**)
- `POST /api/platform/catalog/import` — apply export zip to SQLite (Entity Registry → **Import configuration**)
- `GET /api/platform/catalog/versions` — version history; `POST /api/platform/catalog/rollback` — restore

CLI writes the folder locally.

Review the snapshot, then copy pieces into `deploy/sync/` manually if you intend to ship new seeds in git.

## Offline refresh (tests / CI, no MSSQL)

Metadata only (skips entity JSON — entity derivation needs live schema catalog):

```sh
node deploy/sync/generators/refresh-from-legacy.mjs \
  --evidence-file deploy/sync/fixtures/legacy-pipeline-evidence.fixture.json \
  --metadata-only --force
```

Default pipeline ids: `692,780,788,791,792,798` (content, gate metadata, contract, rule, dataset, pipeline activity).

## Boot sequence (fresh SQLite)

1. Seeds SCD2 strategies from `artifacts/strategies.json` (`runSeeds`).
2. Seeds `sync_run_phases`, `sync_run_kinds`, `sync_run_binding_sources`, `sync_run_presets` from `artifacts/sync-metadata.json`.
3. Refreshes deploy-seeded built-in rows from `sync-metadata.json` on every boot.
4. Seeds sync environments from `sync-environments.json` when the table is empty.
5. **Entity defs** — `seedEntityRegistryIfEmpty` imports from `entity-registry.seed.yaml` (if present) or `artifacts/entities/*.json`.

`ensureSyncDefinitionConfigs` mirrors entity → flow bindings after seed. The Entity Registry UI loads vocabulary via `GET /api/sync-metadata`.

## Model

```
MyMI core.Pipeline + core.Activity.properties
  → sync-metadata.json (stepTypes + flows + wiring)
  → SQLite (editable via Sync metadata UI)
  → publish → execute
```

- **Step types** — reusable handler definitions. Configuration → Actions.
- **Flows** — ordered step instances with per-step params. Configuration → Flows.
- **Wiring** — value source catalog (`customValueSources`). Configuration → Wiring. Handlers reference `{ type: "catalog", id }`.
- **Phases** — fixed platform boundaries for execute scheduling only; not user-editable.
- **Strategies** — SCD2 column policies. Entity Registry → Strategies.

Derivation reads `properties.sync` on each activity. Metadata entry activities (`uspSync*ObjectsTran`) infer `metadataSync`. Activities with `action` starting with `_` are excluded from scope.

## Test coverage

All tests below pass in CI (`packages/sync`):

| Artifact | How it is verified |
|----------|-------------------|
| `sync-metadata.json` | **Golden file** — regenerate from fixture must match committed file exactly |
| `flow-templates.json` | **Golden file** — derived view must match committed file exactly |
| `legacy-activity-sync-specs.json` | **Golden file** — plus full orchestrator round-trip in metadata-only mode |
| Activity → step mapping | Contract audit steps, `_` action filtering, per-activity overlay keys |
| `entities/*.json` | **Structural** — root table, id column, legacy pipeline id, entry sproc, required tables, FK ordering |

```sh
npm test --workspace=@mia/sync -- legacy-sync-generation.test.ts sync-metadata-generation.test.ts legacy-activity-sync-specs-generation.test.ts
```

Entity Registry UI is the long-term CRUD surface; generators are for **reconstructing from legacy** or **refreshing from live MyMI**.
