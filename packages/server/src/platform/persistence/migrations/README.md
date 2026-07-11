# Migrations

Single squashed baseline — terminal SQLite schema for the whole application.

```
migrations/
  0001_baseline.ts   ← full schema (includes sync_catalog_versions)
  archive/           ← historical migrations (audit only, not executed)
  index.ts           ← runner
```

## Adding a schema change

1. Prefer editing `0001_baseline.ts` when the change can be squashed (fresh installs).
2. Otherwise create `0002_your_change.ts` with idempotent `up(db)` and append to `MIGRATIONS`.
3. Restart — runs once, recorded in `schema_migrations`.

Prefer `CREATE TABLE IF NOT EXISTS` and `PRAGMA table_info` before `ALTER`.
Data backfills belong in seeds or admin tools, not in `deploy/sync`.

Seeds (default agent, policies) live in `db/seeds.ts`.

Operator workflow regression tests: `tests/catalog-operator-workflows.test.ts`.

## Fresh / broken database

Delete `~/.mia/mia.db` (or `MIA_DATA_DIR`) and restart.
