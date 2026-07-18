# Migrations

Single squashed baseline — terminal SQLite schema for the whole application.

```
migrations/
  0001_baseline.ts   ← full schema (only migration the runner executes)
  index.ts           ← runner
```

## Fresh database

Delete `~/.mia/mia.db` (or the file under `MIA_DATA_DIR`) and restart.
The runner applies **baseline (v1)** once. That includes:

- Catalog tables: `sync_phases`, `sync_actions`, `sync_flows`, `sync_value_sources`, `sync_environments`, …
- Live SyncDefinitions: `sync_definitions`, `sync_publish_meta`
- Catalog tip history: `sync_catalog_versions`, `sync_catalog_active`

Seeds (default agent, sync metadata from deploy artifacts, etc.) run after migrations in `db/seeds.ts` / boot paths.

## Schema changes

1. Edit `0001_baseline.ts`.
2. Reset the DB (delete `mia.db`) and restart.

Do **not** add a second numbered migration unless you intentionally support in-place upgrades again. If you do, append a new file with an unused version and keep `up()` idempotent.
