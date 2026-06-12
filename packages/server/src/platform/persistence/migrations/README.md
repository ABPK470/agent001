# Migrations

```
migrations/
  0001_baseline.ts   ← full schema (big file)
  0002_*.ts          ← next change (when needed)
  index.ts           ← runner + MIGRATIONS list
```

1. Create `0002_your_change.ts` exporting `{ version, name, up(db) }`.
2. Import it in `index.ts` and append to `MIGRATIONS`.
3. Restart server — runs once, recorded in `schema_migrations`.

Seeds (default agent, policies) live in `db/seeds.ts`, not here.

`0001_baseline` uses `CREATE IF NOT EXISTS` — safe to run on an existing `~/.mia/mia.db`.
If a DB is badly out of date, delete it and restart (dev).
