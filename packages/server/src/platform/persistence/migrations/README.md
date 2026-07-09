# Migrations

Single squashed baseline — terminal SQLite schema for the whole application.

```
migrations/
  0001_baseline.ts   ← full schema
  archive/           ← historical v2–v21 (audit only, not executed)
  index.ts           ← runner
```

## Adding a schema change

1. Create `0002_your_change.ts` with idempotent `up(db)`.
2. Append to `MIGRATIONS` in `index.ts`.
3. Restart — runs once, recorded in `schema_migrations`.

Prefer `CREATE TABLE IF NOT EXISTS` and `PRAGMA table_info` before `ALTER`.
Data backfills belong in seeds or admin tools, not in `deploy/sync`.

Seeds (default agent, policies) live in `db/seeds.ts`.

## Fresh / broken database

Delete `~/.mia/mia.db` (or `MIA_DATA_DIR`) and restart.
