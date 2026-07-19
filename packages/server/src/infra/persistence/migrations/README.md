# Migrations

Single squashed baseline — terminal SQLite schema for the whole application.

```
migrations/
  0001_baseline.ts   ← full schema (only migration the runner executes)
  index.ts           ← runner
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
| `*_configs` | `agent_configs`, `layout_configs`, `policy_configs`, `approval_configs`, `freeze_window_configs`, `proposer_schedule_configs`, `notification_route_configs`, `webhook_drain_configs`, `sync_environment_override_configs`, `browser_domain_policy_configs` (+ existing `llm_config`, `channel_configs`, `browser_proxy_config`) |
| `*_log` | `run_log`, `api_request_log`, `sync_evidence_log` (+ existing `audit_log`, `event_log`, `sync_sql_log`, `browser_audit_log`, `notification_log`) |
| `*_cache` | `tool_knowledge_cache`, `resolved_terms_cache` |

## Fresh database

Delete `~/.mia/mia.db` (or the file under `MIA_DATA_DIR`) and restart.
The runner applies **baseline (v1)** once. That includes:

- Catalog tables: `sync_phases`, `sync_actions`, `sync_flows`, `sync_value_sources`, `sync_environments`, …
- Live SyncDefinitions: `sync_definitions`, `sync_publish_meta`
- Catalog tip history: `sync_catalog_versions`, `sync_catalog_active`
- Entity registry: `entity_active` + `entity_versions`, `scd2_strategy_active` + `scd2_strategy_versions`

Seeds (default agent, sync metadata from deploy artifacts, etc.) run after migrations in `db/seeds.ts` / boot paths.

## Schema changes

1. Edit `0001_baseline.ts`.
2. Reset the DB (delete `mia.db`) and restart.

Do **not** add a second numbered migration unless you intentionally support in-place upgrades again. If you do, append a new file with an unused version and keep `up()` idempotent.
