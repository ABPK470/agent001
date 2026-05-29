# Sync Deploy Seeds

This folder contains deployment-owned sync bootstrap artifacts.

## Files

- `flow-templates.json`: initial execution-flow templates used to seed DB-backed sync definition configs.
- `entity-registry.seed.yaml`: exported Entity Registry snapshot used as scaffold input for initial draft creation.
- `entities/*.json`: repo draft/bootstrap sync definitions used for review, seed fallback, and compile checks.
- `export-entity-registry.sh`: exports current Entity Registry rows from SQLite into `entity-registry.seed.yaml`.
- `create-initial-sync-drafts.sh`: one-shot bootstrap wrapper that exports the Entity Registry snapshot and scaffolds `entities/*.json` from it.
- `scaffold-entity-draft.sh`: convenience wrapper that generates one entity draft JSON into `entities/` by delegating to the package-owned scaffold CLI.
- `scaffold-entity-drafts.sh`: convenience wrapper that generates all entity draft JSON files from one entity-registry input document into `entities/`.

## Authority

These files are initial data and review artifacts. After operators edit and save sync config in the UI, the DB becomes the live source of truth for execution steps and bindings.

## Initial Draft Creation

For the original legacy bootstrap path, start from MSSQL pipeline introspection, not from the app DB.

Run:

```sh
node deploy/mssql/introspect-sync-pipelines.mjs --force
```

That script:

- reads the legacy MSSQL `core.Pipeline` / `core.Activity` definitions for the known ABI sync pipeline ids
- verifies the expected `storedProcedure` wiring in activity `properties`
- writes `deploy/mssql/sync-recipes.json`
- writes `deploy/sync/entities/*.json`

The YAML scaffold path below is a different tool. It is useful after you already have Entity Registry definitions, but it is not the historical first-step bootstrap for the legacy ABI sync entities.

If you already have an entity-registry YAML or JSON document and want to scaffold repo drafts from that, run:

```sh
deploy/sync/scaffold-entity-drafts.sh --input path/to/entities.yaml --force
```

This is a bootstrap/import tool. It is for creating `deploy/sync/entities/*.json`, not for live publish.

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
