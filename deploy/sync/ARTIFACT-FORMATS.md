# Sync catalog artifacts — one authoring shape

There is **one editable Catalog document family** end-to-end: what git seeds ship, what SQLite stores, what Entity Registry edits, and what Catalog snapshot export/import moves.

| Layer | Shape | Role |
|-------|--------|------|
| **Catalog** | `EntityDefinition` + `flowId`, plus flows/actions/sources/envs/strategies | Seed / SQLite / UI / export / import / versions |
| **SyncDefinition** | Process JSON (`PublishedSyncDefinition`) | **Only after Publish** — denormalized compose for preview/execute |

Publish is compose, not copy: resolve scopes→predicates, bind flow steps from `flowId`, snap `executionFlow.catalog`, stamp into SQLite `sync_definitions`.

---

## Authority flow

```
Legacy MSSQL (optional)  →  refresh-from-legacy
                              ↓
deploy/sync seeds (Catalog JSON tree)
                              ↓ boot seed (identity load)
                         SQLite Catalog (same documents)
                              ↓ operator edit / versions
                         SQLite Catalog
                              ↓ export (optional) — same tree
                         personal snapshot zip
                              ↓ Publish (compose)
                         SQLite sync_definitions
                              ↓
                         preview / execute
```

**Export** is optional download — never a Publish side-effect into the repo tree.

---

## Tree layout (seeds **and** Catalog snapshot export)

```
deploy/sync/                         # also: mia-sync-export-<timestamp>/
  sync-environments.json
  artifacts/
    entities/{id}.json               # EntityDefinition + flowId
    sync-metadata.json               # phases, actions, valueSources, flows
    strategies.json
    flow-templates.json              # derived view of sync-metadata.flows
```

| Path | Contents |
|------|----------|
| `artifacts/entities/{id}.json` | Catalog entity document (`EntityDefinition` + `flowId`) |
| `artifacts/sync-metadata.json` | phases, actions, valueSources, flows |
| `artifacts/strategies.json` | SCD2 strategies |
| `artifacts/flow-templates.json` | View of flows (not a second hand-edited SoT) |
| `sync-environments.json` | Environments |

SQLite stores each entity document in `entity_def_versions.body_json`. `sync_definition_configs` is a **derived publish cache** from `entity.flowId`, not a second authoring dialect.

Generator: Authored in temp staging → `entityDefinitionFromAuthoredSync` → write entity files (`materialize-native-entity-seeds.ts --authored-dir=…`). Authored never lands in `artifacts/`.

Import accepts legacy `entity-registry.json` / `sync-definition-configs.json` / `run.template` if present.

---

## SyncDefinition (runtime)

`compilePublishedSyncDefinition` / Publish builds process JSON from Catalog (`entity.flowId` → steps) + live flow catalog. Stored in `sync_definitions`. Preview/execute read **only** that published bundle.

Legacy **AuthoredSyncDefinition** remains the compile/scaffold process JSON base type. It is **not** a seed or export/import Catalog format.

---

## UI

| Action | Meaning |
|--------|---------|
| Catalog snapshot export/import | Move editable Catalog between hosts (same tree as seeds) |
| Catalog versions | Catalog history / rollback |
| Publish | Compose Catalog → SyncDefinitions for preview/execute |

See [README.md](./README.md) and [packages/sync/SYNC-MODEL.md](../../packages/sync/SYNC-MODEL.md).
