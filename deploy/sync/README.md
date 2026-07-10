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

## Authority model

```
Live MSSQL (optional)  →  refresh-from-legacy  →  deploy/sync/artifacts/*
                                                      ↓ server boot seed
                                                 SQLite (operator edits)
                                                      ↓ publish
                              sync-definitions/published/definitions.bundle.json
                                                      ↓
                                               preview / execute
```

- **Shipped artifacts** — default for first boot when the registry is empty.
- **Refresh from MSSQL** — on a deployed dev/UAT host with corp DB access, admins regenerate artifacts from ground truth, restart, then publish. UI: Policies → Platform → **Refresh from database**.
- **After boot** — SQLite is live for entity registry, sync metadata, and configs. Deploy artifacts re-seed built-in catalog rows on every boot; operator UI edits win for non-built-in data.
- **Runtime execute** reads the **published bundle**, not deploy files directly.

## Layout

| Path | Role |
|------|------|
| `generators/refresh-from-legacy.mjs` | **Only CLI** — rebuild all artifacts |
| `helpers/` | Derivation libraries (imported by generator + server API) |
| `artifacts/` | Shipped bootstrap JSON — or output of a live MSSQL refresh |
| `fixtures/` | Offline pipeline evidence for tests / offline generation |
| `sync-environments.json` | Environment registry seed |

## Files

- `artifacts/sync-metadata.json` — MyMI-derived vocabulary: step types, flows, binding sources.
- `artifacts/flow-templates.json` — derived view of `sync-metadata.flows`.
- `artifacts/entities/*.json` — entity definition drafts for cold-start seed and review.
- `fixtures/legacy-pipeline-evidence.fixture.json` — offline pipeline rows for tests.
- `fixtures/legacy-activity-sync-specs.json` — offline activity `properties.sync` snapshot (`pipelineId:sequence` keys).

## Helpers (derivation only)

| Module | Purpose |
|--------|---------|
| `refresh-from-legacy.mjs` | Orchestrator — writes all artifact outputs |
| `legacy-pipeline-evidence.mjs` | Fetch `core.Pipeline` + `core.Activity` from MSSQL or fixture |
| `legacy-entity-derivation.mjs` | Pipeline → `artifacts/entities/*.json` (table scopes, predicates) |
| `sync-metadata-derivation.mjs` | Pipeline → `sync-metadata.json` (step types + flows) |
| `legacy-activity-sync-specs.mjs` | Build offline activity overlay fixture |
| `catalog-index.mjs` | MSSQL schema snapshot for entity FK closure |
| `sync-metadata-phases.mjs` | Fixed platform phase vocabulary |
| `sync-metadata-normalize.mjs` | ValueSource normalization on derived metadata |
| `value-source-seeds.mjs` | Shipped value source catalog (plan context, SQL, step fields) |

No one-shot migration scripts — artifacts in git are already on the current model.

## Refresh from MSSQL

Run from **repo root** on a host with MSSQL configured in `.env`:

```sh
node deploy/sync/generators/refresh-from-legacy.mjs --connection uat --force
```

Writes:

| Output | Content |
|--------|---------|
| `artifacts/entities/*.json` | Entity definitions (content, contract, dataset, gateMetadata, pipelineActivity, rule) |
| `artifacts/sync-metadata.json` | Step types (actions) + flows (pipelines) |
| `artifacts/flow-templates.json` | View of `sync-metadata.flows` |
| `fixtures/legacy-activity-sync-specs.json` | Offline `pipelineId:sequence` overlay |

**On a running server:** Policies → Platform → **Refresh from database** runs the same helper, then re-imports into SQLite.

After refresh: restart server → review Entity Registry → **Publish**.

## Offline refresh (tests / CI, no MSSQL)

Metadata only (skips entity JSON — entity derivation needs live schema catalog):

```sh
node deploy/sync/generators/refresh-from-legacy.mjs \
  --evidence-file deploy/sync/fixtures/legacy-pipeline-evidence.fixture.json \
  --metadata-only --force
```

Default pipeline ids: `692,780,788,791,792,798` (content, gate metadata, contract, rule, dataset, pipeline activity).

## Boot sequence (fresh SQLite)

1. Seeds SCD2 strategies from bundled code (`runSeeds`).
2. Seeds `sync_run_phases`, `sync_run_kinds`, `sync_run_presets` from `artifacts/sync-metadata.json`.
3. Refreshes deploy-seeded phase and step-type rows from `sync-metadata.json` on every boot.
4. **Entity defs** — `seedEntityRegistryIfEmpty` imports from `entity-registry.seed.yaml` (if present) or `artifacts/entities/*.json` when SQLite has no entities.

`ensureSyncDefinitionConfigs` mirrors entity → flow bindings after seed. The Entity Registry UI loads vocabulary via `GET /api/sync-metadata`.

## Model

```
MyMI core.Pipeline + core.Activity.properties
  → sync-metadata.json (stepTypes + flows)
  → SQLite (editable via Sync metadata UI)
  → publish → execute
```

- **Step types** — reusable handler definitions. Edited under Sync metadata → Actions.
- **Flows** — ordered step instances with per-step params. Edited under Sync metadata → Flows.
- **Phases** — fixed platform boundaries for execute scheduling only; not user-editable.

Derivation reads `properties.sync` on each activity. Metadata entry activities (`uspSync*ObjectsTran`) infer `metadataSync`. Activities with `action` starting with `_` are excluded from scope.

## Test coverage

All tests below pass in CI (`packages/sync`):

| Artifact | How it is verified |
|----------|-------------------|
| `sync-metadata.json` | **Golden file** — regenerate from fixture must match committed file exactly |
| `flow-templates.json` | **Golden file** — derived view must match committed file exactly |
| `legacy-activity-sync-specs.json` | **Golden file** — plus full orchestrator round-trip in metadata-only mode |
| Activity → step mapping | Contract audit steps, `_` action filtering, per-activity overlay keys |
| `entities/*.json` | **Structural** — root table, id column, legacy pipeline id, entry sproc, required tables, FK ordering (when catalog cache present); each file validates as importable entity definition |

**Not proven automatically in CI:** live MSSQL round-trip; byte-for-byte golden match of every entity JSON file; that every production activity has `properties.sync` without the offline overlay fixture.

The offline fixture is a reviewed snapshot of the six legacy pipelines. Metadata/flow seeds are locked to it. Entity seeds were generated from the same pipelines + schema catalog and reviewed manually.

```sh
npm test --workspace=@mia/sync -- legacy-sync-generation.test.ts sync-metadata-generation.test.ts legacy-activity-sync-specs-generation.test.ts
```

Entity Registry UI is the long-term CRUD surface; generators are for **reconstructing from legacy** or **refreshing from live MyMI**.
