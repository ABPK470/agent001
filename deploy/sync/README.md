# Sync deploy seeds

Bootstrap data for sync: rebuild **legacy MyMI pipelines** into mia **Catalog** (entity registry + sync metadata), seed SQLite on first boot, then **Publish** to compose runtime SyncDefinitions.

**One authoring shape:** EntityDefinition + catalog JSON. See [ARTIFACT-FORMATS.md](./ARTIFACT-FORMATS.md).

**Not in this tree:** SQLite schema migrations live in `packages/server/src/infra/persistence/migrations/`.

## Why this exists

Legacy MyMI has **pipelines** and **activities** — not “entities”. “Entity” is a mia term we invented here.

| Legacy (MyMI / ABI) | Mia |
|---------------------|-----|
| `core.Pipeline` | sync **flow** (one per entity type) |
| `core.Activity` | flow **step** / **action** |
| `uspSync*ObjectsTran` entry activity | entity type + table scopes |
| `properties.sync` on an activity | step type handler definition |

These scripts **reconstruct** legacy ground truth into deploy seeds. After first boot, operators manage everything in **Entity Registry** (full CRUD). Generators are for:

1. **Cold start** — ship reviewed seeds in git
2. **Refresh** — pull latest from live MyMI when MSSQL is available

## Authority model (one path)

```
Live MSSQL (optional)  →  refresh-from-legacy  →  deploy/sync seeds (Catalog)
                                                      ↓ server boot seed
                                                 SQLite Catalog (operator edits)
                                                      ↓ export (optional)
                                                 Catalog snapshot zip
                                                      ↓ Publish
                              SQLite sync_definitions (SyncDefinition JSON)
                                                      ↓
                                               preview / execute
```

- **Shipped seeds** — default for first boot when SQLite is empty (`EntityDefinition` + `sync-definition-configs.json` + metadata).
- **Refresh from MSSQL** — regenerate seeds from ground truth, restart, then Publish. UI: Policies → Platform → **Refresh from database**.
- **After boot** — SQLite is the source of truth for operator edits.
- **Export** — Catalog snapshot download only.
- **Runtime** reads **SyncDefinitions in SQLite**, not deploy files.

Ground-truth lock: `packages/sync/src/test-support/__goldens__/legacy-refresh/` (G2/G3). Regenerating seeds must keep those goldens green.

Handler wiring always uses `{ "type": "catalog", "id": "…" }` — no legacy shorthand types in artifacts.

## Layout

| Path | Role |
|------|------|
| `generators/refresh-from-legacy.mjs` | **Only CLI** — rebuild all artifacts |
| `helpers/` | Derivation libraries (imported by generator + server API) |
| `artifacts/` | Shipped bootstrap JSON — or output of a live MSSQL refresh |
| `fixtures/` | Offline pipeline evidence for tests / offline generation |
| `sync-environments.json` | Environment registry seed |
| `entity-registry.seed.yaml` | Optional EntityDefinition YAML cold-start |

## Shipped artifacts

| File | SQLite tables | UI surface |
|------|---------------|------------|
| `artifacts/entities/*.json` | `entity_defs` (EntityDefinition) | Entity Registry |
| `artifacts/sync-definition-configs.json` | `sync_definition_configs` | Configuration / run bindings |
| `artifacts/sync-metadata.json` | phases, actions, valueSources, flows | Configuration → Flows / Actions / Sources |
| `artifacts/strategies.json` | SCD2 strategies | Strategies |
| `artifacts/flow-templates.json` | derived flow view | publish helper |
| `sync-environments.json` | `sync_environments` | Environments |

## Commands

```bash
# Offline rebuild from fixtures (then materialize native entity seeds)
node deploy/sync/generators/refresh-from-legacy.mjs \
  --evidence deploy/sync/fixtures/legacy-pipeline-evidence.fixture.json \
  --force

# Live MSSQL (requires connector)
node deploy/sync/generators/refresh-from-legacy.mjs --connection uat --force
```

After refresh: restart server → review Entity Registry → **Publish**.

## Materialize step

Refresh still derives Authored process JSON in memory for table/predicate logic, then runs:

`npx tsx packages/sync/scripts/materialize-native-entity-seeds.ts`

which converts 1:1 via `entityDefinitionFromAuthoredSync` and writes EntityDefinition files + `sync-definition-configs.json`.

## Related

- [ARTIFACT-FORMATS.md](./ARTIFACT-FORMATS.md)
- [packages/sync/SYNC-MODEL.md](../../packages/sync/SYNC-MODEL.md)
