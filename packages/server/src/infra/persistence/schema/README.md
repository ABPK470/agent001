# Platform schema toolkit

Track B of the RDBMS-agnostic program ([plan](../../../../../.cursor/plans/sqlite_to_mssql_readiness_3d8e6870.plan.md)).

## When can we swap SQLite → MSSQL/Postgres?

**Not yet.** It is **explicitly in the plan**:

| Milestone | What | Status |
| --- | --- | --- |
| 3 | Schema toolkit + async SQLite adapter | **In progress** — Kysely table-by-table |
| 4 | Second dialect (`mssql` *or* `postgres`) + multi-dialect migrator | **Scaffold only** — boot refuses unimplemented kinds |
| 8 | Memory search port (FTS) | Last hard piece |

Honest sizing in the plan: platform agnostic is **large (months)** — ~70 tables, async ripple, search redesign. Sync warehouse multi-dialect is a **separate** track and is further along.

## Shape

| Piece | Role |
| --- | --- |
| `tables.ts` | Column contracts (`PlatformDatabase`) |
| `kysely.ts` | Process-wide `Kysely` over the SQLite file |
| `execute.ts` | Compile → better-sqlite3 sync execute |
| `@mia/sql-kit` `MigrationRunner` | Shared migrator contract; SQLite implements today |

## Cutover tables (Kysely)

- `connectors`, `users`, `sync_environments`, `sessions`
- `llm_config`, `freeze_window_configs`

Heavy/stats SQL in some repos may still be raw until those paths move. DDL still lives in numbered SQLite migrations (`adapters/sqlite/migrations`). Next: more repos → dialect-specific migration bodies → real `mssql`/`postgres` `PlatformStore`.
