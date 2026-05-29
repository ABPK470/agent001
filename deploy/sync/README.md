# Sync Deploy Seeds

This folder contains deployment-owned sync bootstrap generators, helpers, and artifacts.

## Files

- `artifacts/flow-templates.json`: initial execution-flow templates used to seed DB-backed sync definition configs.
- `artifacts/entities/*.json`: repo draft/bootstrap sync definitions used for review, seed fallback, and compile checks.
- `generators/*.mjs`: executable legacy bootstrap seed builders.
- `helpers/*.mjs`: non-executable derivation helpers used by the generators.
- `entity-registry.seed.yaml`: exported Entity Registry snapshot used as scaffold input for initial draft creation.
- `export-entity-registry.sh`: exports current Entity Registry rows from SQLite into `entity-registry.seed.yaml`.
- `create-initial-sync-drafts.sh`: one-shot bootstrap wrapper that exports the Entity Registry snapshot and scaffolds `artifacts/entities/*.json` from it.
- `scaffold-entity-draft.sh`: convenience wrapper that generates one entity draft JSON into `artifacts/entities/` by delegating to the package-owned scaffold CLI.
- `scaffold-entity-drafts.sh`: convenience wrapper that generates all entity draft JSON files from one entity-registry input document into `artifacts/entities/`.

## Authority

These files are initial data and review artifacts. After operators edit and save sync config in the UI, the DB becomes the live source of truth for execution steps and bindings.

## Initial Draft Creation

For the original legacy bootstrap path, start from the deploy/sync generators, not from the app DB.

Run:

```sh
node deploy/sync/generators/generate-entities-from-legacy-pipelines.mjs --connection uat --force
node deploy/sync/generators/generate-flow-templates-from-legacy-pipelines.mjs --connection uat --force
```

These scripts:

- read the legacy MSSQL `core.Pipeline` / `core.Activity` definitions for the known ABI sync pipeline ids
- verify the expected `storedProcedure` wiring in activity `properties`
- write `deploy/sync/artifacts/entities/*.json`
- write `deploy/sync/artifacts/flow-templates.json`

The YAML scaffold path below is a different tool. It is useful after you already have Entity Registry definitions, but it is not the historical first-step bootstrap for the legacy ABI sync entities.

If you already have an entity-registry YAML or JSON document and want to scaffold repo drafts from that, run:

```sh
deploy/sync/scaffold-entity-drafts.sh --input path/to/entities.yaml --force
```

This is a bootstrap/import tool. It is for creating `deploy/sync/artifacts/entities/*.json`, not for live publish.

If you want an export of the current app DB Entity Registry first, run:

```sh
deploy/sync/export-entity-registry.sh
deploy/sync/scaffold-entity-drafts.sh --input deploy/sync/entity-registry.seed.yaml --force
```

Or use the one-shot wrapper:

```sh
deploy/sync/create-initial-sync-drafts.sh
```

That path reflects current SQLite-backed admin state. It is not the original legacy MSSQL bootstrap path.
