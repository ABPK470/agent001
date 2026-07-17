# Historical migrations (v2–v21)

These incremental migrations were **folded into `0001_baseline.ts`** in June 2026.
They are kept for audit history only — the runner no longer imports them.

If your `schema_migrations` table already records versions 2–21, nothing else to do.
Fresh installs run baseline (v1) + `drop_platform_setup` (v22) only.
