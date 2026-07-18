# Sync catalog artifacts — one authoring shape

There is **one editable catalog shape** end-to-end: what SQLite stores, what Entity Registry edits, what git seeds ship, and what Catalog snapshot export/import moves.

| Layer | Shape | Role |
|-------|--------|------|
| **Catalog** | `EntityDefinition` (incl. `flowId`) + flows/actions/sources/envs/strategies | Editable tip (seed, UI, versions, export/import) |
| **SyncDefinition** | Process JSON (`PublishedSyncDefinition`) | **Only after Publish** — denormalized compose for preview/execute |

Publish is compose, not copy: resolve scopes→predicates, bind flow steps, snap `executionFlow.catalog`, stamp versions into SQLite `sync_definitions`.

---

## Authority flow

```
Legacy MSSQL (optional)  →  refresh-from-legacy
                              ↓
deploy/sync seeds (native Catalog JSON)
                              ↓ boot seed (identity load)
                         SQLite Catalog tip
                              ↓ operator edit / versions
                         SQLite Catalog tip
                              ↓ Publish (compose)
                         SQLite sync_definitions
                              ↓
                         preview / execute
```

**Export** (Catalog snapshot) is optional download — never a Publish side-effect into the tree.

---

## Shipped seed layout

| Path | Contents |
|------|----------|
| `artifacts/entities/{id}.json` | **EntityDefinition** + `flowId` |
| `artifacts/sync-metadata.json` | phases, actions, valueSources, flows |
| `artifacts/strategies.json` | SCD2 strategies |
| `artifacts/flow-templates.json` | View of flows (compile helper) |
| `sync-environments.json` | Environments |

Boot seeds SQLite tip from these docs; `sync_definition_configs` is a derived publish cache from `entity.flowId`. Generator: Authored in temp staging → `entityDefinitionFromAuthoredSync` → EntityDefinition + `flowId` (`materialize-native-entity-seeds.ts --authored-dir=…`). Authored never lands in `artifacts/`. Goldens: `packages/sync/src/test-support/__goldens__/legacy-refresh/`.

---

## Catalog snapshot (export / import)

Bulk zip from Entity Registry → **Catalog snapshot** (`mia-sync-export-*`):

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

Same semantic catalog as seeds; entities are bulk `entity-registry.json` with per-entity `flowId`. Import still accepts a legacy `sync-definition-configs.json` / `run.template` if present.

---

## SyncDefinition (runtime)

`compilePublishedSyncDefinition` / Publish builds process JSON from Catalog tip (`entity.flowId` → steps) + live flow catalog. Stored in `sync_definitions`. Preview/execute read **only** that published bundle.

Legacy **AuthoredSyncDefinition** remains the compile/runtime process JSON base type (Publish / scaffold). It is **not** a seed or export/import authoring format.

---

## UI

| Action | Meaning |
|--------|---------|
| Catalog snapshot export/import | Move editable Catalog between hosts |
| Catalog versions | Tip history / rollback |
| Publish | Compose tip → SyncDefinitions for preview/execute |

See [README.md](./README.md) and [packages/sync/SYNC-MODEL.md](../../packages/sync/SYNC-MODEL.md).
