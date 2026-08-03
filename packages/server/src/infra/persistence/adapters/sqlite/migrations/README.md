# Migrations (SQLite)

Terminal schema lives in a single squashed baseline. Server RDBMS peers
(mssql/postgres) use a separate ledger and registry — see
`packages/server/src/infra/persistence/migrations/registry.ts`.

```
migrations/
  0001_baseline.ts              ← full schema for fresh installs
  0006_drop_browser_tables.ts   ← in-place drop of retired Playwright tables (v6)
  index.ts                      ← runner
  runner.ts                     ← MigrationRunner adapter for sql-kit
```

## Table naming (versioned documents)

| Pattern | Meaning |
| ------- | ------- |
| `*_active` | Current-version cursor only (`current_version`, optional `retired_at`). No document body. |
| `*_versions` | Append-only history; document body / snapshot lives here. |

Pairs today: `entity_active` + `entity_versions`, `scd2_strategy_active` + `scd2_strategy_versions`, `sync_catalog_active` + `sync_catalog_versions`.

`*_active` exists only when a matching `*_versions` exists. Mutable Catalog rows without per-row history (`sync_flows`, `connectors`, …) keep plain domain names — they are not `*_active`.

Other suffixes: `*_config(s)`, `*_log` / `*_audit` / `*_history`, `*_cache`. Roots, runs, and FK children use plain names.

### Config / log / cache renames (postfix pass)

| Kind | Tables |
| ---- | ------ |
| `*_configs` | `layout_configs`, `policy_configs`, `approval_configs`, `freeze_window_configs`, `proposer_schedule_configs`, `notification_route_configs`, `webhook_drain_configs`, `sync_environment_override_configs` (+ existing `llm_config`, `channel_configs`) |
| `*_log` | `run_log`, `api_request_log`, `sync_evidence_log` (+ existing `audit_log`, `event_log`, `sync_sql_log`, `notification_log`) |
| `*_cache` | `tool_knowledge_cache`, `resolved_terms_cache` |

## Fresh database

Delete `~/.mia/mia.db` (or the file under `MIA_DATA_DIR`) and restart.
The runner applies **baseline (v1)** once. That includes catalog/sync tables,
entity registry, memory, eval dataset entries, and the rest of the product schema.

Seeds (sync metadata from deploy artifacts, SCD2 strategies, factory policies,
etc.) run after migrations in `db/seeds.ts` / boot paths.

## Schema changes

**Default:** edit `0001_baseline.ts` and reset the DB (delete `mia.db`). Fresh
installs only need the baseline to be correct.

**In-place upgrade:** when an existing install must pick up a change without a
reset (new table, dropped column), append a new numbered migration
(`0002_….ts`, …), register it in `index.ts`, and keep `up()` idempotent.
