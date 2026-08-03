# Platform store adapters

| Path | Role |
| --- | --- |
| `sqlite/` | Production local/dev store (better-sqlite3 + Kysely cutover) |
| `mssql/` | Milestone 4 scaffold — not bootable yet |
| `postgres/` | Milestone 4 scaffold — not bootable yet |

Plan sequencing ([sqlite_to_mssql_readiness](../../../../.cursor/plans/sqlite_to_mssql_readiness_3d8e6870.plan.md)):

3. Schema toolkit + async SQLite (in progress — table-by-table Kysely)
4. Second dialect adapter + multi-dialect migrator
8. Memory search port (last)

Warehouse Sync adapters live under `@mia/sync` / server connector pools — **never**
share pools with platform store.
