# Migrations

Squashed baseline plus small numbered follow-ups for changes that existing
installs need applied in place (new tables, dropped columns/tables).

```
migrations/
  0001_baseline.ts             ← full schema for fresh installs
  0002_sync_tool_approvals.ts  ← follow-up: new table
  0003_drop_agent_configs.ts   ← follow-up: dropped table + column
  index.ts                     ← runner
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
| `*_configs` | `layout_configs`, `policy_configs`, `approval_configs`, `freeze_window_configs`, `proposer_schedule_configs`, `notification_route_configs`, `webhook_drain_configs`, `sync_environment_override_configs`, `browser_domain_policy_configs` (+ existing `llm_config`, `channel_configs`, `browser_proxy_config`) |
| `*_log` | `run_log`, `api_request_log`, `sync_evidence_log` (+ existing `audit_log`, `event_log`, `sync_sql_log`, `browser_audit_log`, `notification_log`) |
| `*_cache` | `tool_knowledge_cache`, `resolved_terms_cache` |

## Fresh database

Delete `~/.mia/mia.db` (or the file under `MIA_DATA_DIR`) and restart.
The runner applies **baseline (v1)** once. That includes:

- Catalog tables: `sync_phases`, `sync_actions`, `sync_flows`, `sync_value_sources`, `sync_environments`, …
- Live SyncDefinitions: `sync_definitions`, `sync_publish_meta`
- Catalog tip history: `sync_catalog_versions`, `sync_catalog_active`
- Entity registry: `entity_active` + `entity_versions`, `scd2_strategy_active` + `scd2_strategy_versions`

Seeds (sync metadata from deploy artifacts, SCD2 strategies, factory policies, etc.) run after migrations in `db/seeds.ts` / boot paths.

## Schema changes

Most changes: edit `0001_baseline.ts` and reset the DB (delete `mia.db`) — fresh installs only need the baseline to be correct.

When existing installs must pick up the change without a reset (new table, dropped column/table), append a new numbered migration instead (see `0002`, `0003`) and keep `up()` idempotent — it may run against a DB that already has the baseline shape (fresh install) or one that predates the change (upgrade).
