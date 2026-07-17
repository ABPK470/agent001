# Artifact formats — Format A vs Format B

Two JSON shapes carry the **same semantic catalog** (entities, flows, strategies, environments) but target different workflows. Both are built from **SQLite** — the operator-edited source of truth after first boot.

| Label | TypeScript type | Primary use |
|-------|-----------------|-------------|
| **Format A** | `AuthoredSyncDefinition` | Git boot seeds, commit to `deploy/sync/` |
| **Format B** | `EntityDefinition` (+ run bindings) | Entity Registry UI, backup/restore |

Code and tests use **Format A** / **Format B** consistently. UI labels use plainer names (see [UI and API](#ui-and-api)).

---

## Authority flow

```
deploy/sync/artifacts/entities/*.json     Format A (git seeds)
              ↓ boot seed / import A→B
         SQLite (EntityDefinition rows)
              ↓ export
    ┌─────────┴─────────┐
    ↓                   ↓
Format B snapshot   Format A zip
(catalog snapshot)  (deploy artifacts)
    ↓                   ↓
import B→B          import A→B
(round-trip)        (compile into SQLite)
              ↓ publish
sync-definitions/published/definitions.bundle.json
              ↓
         preview / execute
```

**Publish** always reads SQLite and writes the runtime bundle. Neither export format is read directly at execute time.

---

## Format A — deploy / git layout

**What it is:** Compiled entity artifacts — the shape shipped in git under `deploy/sync/artifacts/entities/`.

| Aspect | Detail |
|--------|--------|
| **One entity** | Single JSON file: `AuthoredSyncDefinition` |
| **Bulk zip** | `mia-deploy-artifacts-<timestamp>.zip` |
| **Entity files** | `artifacts/entities/{entityId}.json` |
| **Compiled from** | `EntityDefinition` + sync admin config + flow catalog |
| **Typical goal** | Review → commit seeds → boot new hosts |

### Entity shape (high level)

Flat top-level fields; tables live under `metadata`:

- `id`, `rootTable`, `idColumn`, `displayName`, …
- `strategy`, `bindings`, `ownership` — governance and service refs
- `metadata.tables[]` — scope as SQL `predicate` strings
- `executionFlow.steps[]` — resolved flow steps
- `provenance.sourceArtifact` — git path this file mirrors

Example path: `deploy/sync/artifacts/entities/dataset.json`.

### Bulk zip layout

```
mia-deploy-artifacts-<timestamp>/
  manifest.json                 # kind: "deploy-git-layout"
  sync-environments.json
  artifacts/
    sync-metadata.json
    strategies.json
    flow-templates.json
    entities/
      dataset.json
      contract.json
      …
```

Shared catalog files match Format B exports (same SQLite source).

---

## Format B — registry / catalog snapshot

**What it is:** The shape the Entity Registry UI loads and saves — a direct projection of SQLite rows.

| Aspect | Detail |
|--------|--------|
| **One entity** | YAML or JSON via Entity Registry (same fields as `EntityDefinition`) |
| **Bulk zip** | `mia-sync-export-<timestamp>.zip` |
| **Entity bulk file** | `artifacts/entity-registry.json` — all entities in one document |
| **Bindings file** | `artifacts/sync-definition-configs.json` — per-entity flow/service/env |
| **Typical goal** | Backup, version history, move catalog between hosts without git |

### Entity shape (high level)

Registry-native structure (mirrors the edit modal):

- `tables[]` with nested `scope` objects (not flat `metadata.tables`)
- `scd2`, `policies`, `lineageRefs`, `provenance`
- optional `run` block: `{ template, service, environment }` on each entity in exports
- `__meta` — version, `createdAt`, `retiredAt` (informational on export)

Bulk export also includes `sync-definition-configs.json` when configs exist (admin bindings as a separate table projection).

### Bulk zip layout

```
mia-sync-export-<timestamp>/
  manifest.json                 # layout: "deploy/sync mirror"
  sync-environments.json
  artifacts/
    sync-metadata.json
    strategies.json
    flow-templates.json
    entity-registry.json
    sync-definition-configs.json   # when present
```

**Note:** Format B zip is *similar* to the `deploy/sync/` tree but is **not** identical — entities are in `entity-registry.json`, not `artifacts/entities/*.json`.

---

## Shared catalog files (both formats)

These files are the same in both bulk exports (built by `buildDeployCatalogSnapshot()`):

| File | SQLite source | UI |
|------|---------------|-----|
| `artifacts/sync-metadata.json` | phases, step types, wiring, flows | Configuration |
| `artifacts/strategies.json` | SCD2 strategies | Entity Registry → Strategies |
| `artifacts/flow-templates.json` | derived view of flows | compile-time helper |
| `sync-environments.json` | environment registry | Policies → Environments |

---

## Conversion

| Direction | Mechanism | Notes |
|-----------|-----------|-------|
| **A → B** | `import-authored-sync.ts`, `import-deploy-git-artifacts.ts` | Compiles authored JSON into `EntityDefinition` + sync config rows |
| **B → A** | `entityToAuthoredSyncDefinition()` in `authored-sync-document.ts` | Requires exportable entity (valid scopes, no degraded predicates) |
| **B → B** | `import-deploy-artifacts.ts` | Catalog snapshot import — replaces catalog sections in SQLite |
| **A → A** | N/A as round-trip file format | Import A→B, export B→A if you need a refreshed git file |

Core entity semantics round-trip: tests in `packages/server/tests/artifact-format-roundtrip.test.ts` cover **A → B → A** and **B bulk export/import**.

Compilers (see [SYNC-MODEL.md](../../packages/sync/SYNC-MODEL.md)):

| Function | Output |
|----------|--------|
| `entityDefinitionFromAuthoredSync` | Format B from Format A |
| `entityToAuthoredSyncDefinition` / `scaffoldSyncDefinition` | Format A from Format B |
| `compilePublishedSyncDefinition` | Published bundle (runtime) |

---

## UI and API

### Entity Registry platform menu (⚙)

| UI label | Format | Export endpoint | Import endpoint |
|----------|--------|-----------------|-----------------|
| **Catalog snapshot** | B | `POST /api/platform/artifacts/export/download` | `POST /api/platform/catalog/import` |
| **Deploy artifacts** | A | `POST /api/platform/deploy-artifacts/export/download` | `POST /api/platform/deploy-artifacts/import` |

Catalog **versions** (`GET /api/platform/catalog/versions`, rollback) store Format B snapshots in SQLite history.

### Per-entity (Entity Registry detail view)

| UI / action | Format | Endpoint |
|-------------|--------|----------|
| YAML / registry JSON export | B | `GET /api/entity-registry/entities/:id.yaml`, `…/registry.json` |
| Deploy artifact copy/download | A | `GET /api/entity-registry/entities/:id/artifact.json` |
| Import deploy artifact | A → B | `POST /api/entity-registry/entities/import-artifact` |
| Import YAML / registry JSON | B | `POST /api/entity-registry/entities/import-yaml`, `…/import-registry-json` |

### CLI

```sh
# Format B — catalog snapshot folder (default ~/Downloads)
npm run export-deploy-catalog --workspace @mia/server

# Format B — entities only
npm run entity-registry:export --workspace @mia/server
```

There is no dedicated CLI for Format A bulk zip; use the API or export from the UI.

---

## When to use which

| Goal | Use |
|------|-----|
| Backup current operator state, rollback, move between servers | **Format B** (catalog snapshot) |
| Commit reviewed seeds to git, cold-start new deployments | **Format A** (deploy artifacts) |
| Edit in Entity Registry UI | **Format B** (YAML/JSON import/export) |
| Replace one entity from a reviewed git file | **Format A** per-entity import |
| Factory reset from shipped repo files | Policies → Platform → **Use shipped artifacts** (loads A from `deploy/sync/`, re-seeds built-ins) |

**Import deploy artifacts (Format A)** updates SQLite **without** a factory reset — it upserts entities and platform catalog files. That is different from **Use shipped artifacts**, which wipes and re-seeds from the repo.

---

## Code map

| Concern | Path |
|---------|------|
| Format B export | `packages/server/src/api/platform/application/export-deploy-artifacts.ts` |
| Format B import | `packages/server/src/api/platform/application/import-deploy-artifacts.ts` |
| Format A export | `packages/server/src/api/platform/application/export-deploy-git-artifacts.ts` |
| Format A import (bulk) | `packages/server/src/api/platform/application/import-deploy-git-artifacts.ts` |
| Format A import (single) | `packages/server/src/api/sync/application/import-authored-sync.ts` |
| Format B entity YAML/JSON | `packages/server/src/api/sync/domain/entity-yaml.ts` |
| Format A document | `packages/server/src/api/sync/domain/authored-sync-document.ts` |
| Round-trip tests | `packages/server/tests/artifact-format-roundtrip.test.ts` |

---

## Related docs

- [deploy/sync/README.md](./README.md) — boot seeds, refresh from MSSQL, export CLI
- [packages/sync/SYNC-MODEL.md](../../packages/sync/SYNC-MODEL.md) — terminology and publish chain
