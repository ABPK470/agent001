# Platform schema toolkit

Track B of the RDBMS-agnostic program ([plan](../../../../../.cursor/plans/sqlite_to_mssql_readiness_3d8e6870.plan.md)).

## When can we swap SQLite → MSSQL/Postgres?

**Not yet.** Boot still refuses non-sqlite. Progress:

| Milestone | What | Status |
| --- | --- | --- |
| 3 | Schema toolkit + async SQLite adapter | **Nearly done** — product repos on Kysely; leftovers below |
| 4 | Second dialect (**hosted default: mssql**) + multi-dialect migrator | **In progress** — config, pool, pilot DDL registry, migrator; repos/execute still SQLite |
| 8 | Memory search port (FTS) | Last hard piece |

Honest sizing in the plan: platform agnostic is **large (months)** — ~70 tables, async ripple, search redesign. Sync warehouse multi-dialect is a **separate** track and is further along.

## Shape

| Piece | Role |
| --- | --- |
| `tables.ts` | Column contracts (`PlatformDatabase`) |
| `kysely.ts` | Process-wide `Kysely` over the SQLite file |
| `execute.ts` | Compile → better-sqlite3 sync execute |
| `@mia/sql-kit` `MigrationRunner` / `applyMultiDialectPending` | Shared migrator contract |
| `migrations/registry.ts` | Multi-dialect peer DDL (mssql pilot today) |
| `adapters/mssql/**` | Platform pool + migrator (not product-ready) |

## Cutover tables (Kysely)

- `connectors`, `users`, `sync_environments`, `sessions` (incl. stats CTE)
- `llm_config`, `freeze_window_configs`
- `notifications`, `notification_route_configs`, `notification_log`
- `api_request_log`, `proposer_schedule_configs`, `sync_value_sources`
- `sync_catalog_versions`, `sync_catalog_active`
- `approval_configs`, `sync_approvals`, `sync_approval_tokens`
- `conversations`, `outbound_messages`, `delivery_attempts`, `channel_configs`
- `effects`, `file_snapshots`
- `threads`, `runs` (core CRUD/upsert; audit & token-usage browsers still raw filters)
- `token_usage`, `checkpoints`, `run_log`, `trace_entries`, `audit_log` (simple paths)
- `webhook_drain_configs`, `agent_messages`
- `proposer_runs`, `sync_proposals`, `sync_proposal_history`
- `sync_publish_meta`, `sync_definitions`, `sync_runs`, `sync_sql_log`
- `run_tool_approvals`, `sync_tool_approvals`, `tool_results`
- `entity_active` / `entity_versions`, `scd2_strategy_*`
- `event_log` (EventStore), layouts/policies/env overrides, sync catalog
  (phases/actions/flows)
- `sync_audit`, `sync_evidence_log`, `eval_dataset_entries`
- `runs` audit + token-usage admin browsers (fully Kysely)

Still raw-ish: memory FTS adapter (milestone 8), a few `getDb` bootstrap/DDL/pragma
paths (`lifecycle` vacuum, `sync_tool_approvals` ensure-table, entity wipe,
attachments/evidence). Milestone 4 next: grow mssql registry toward baseline
parity and dialect-aware `execute` before enabling boot.
