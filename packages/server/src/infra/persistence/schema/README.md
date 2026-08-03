# Platform schema toolkit

Track B of the RDBMS-agnostic program: typed SQL under
`server/infra/persistence` only (not Sync/Agent cores — `drizzle-orm` stays
denylisted there; this folder uses **Kysely**).

## Shape

| Piece | Role |
| --- | --- |
| `tables.ts` | Column contracts (`PlatformDatabase`) |
| `kysely.ts` | Process-wide `Kysely` over the SQLite file |
| Repos (`adapters/sqlite/db/*`) | Compile with Kysely, execute via better-sqlite3 (sync cutover) |

## First table

`connectors` is the pilot. DDL still lives in numbered SQLite migrations;
the toolkit owns query shape. Next: more repos, then a multi-dialect migrator
and `MIA_PLATFORM_STORE=postgres|mssql` adapters.

## Rules

- Platform store and warehouse Sync never share a pool.
- New repos prefer `getPlatformDb()` compile → driver execute.
- Async `PlatformStore.transactionAsync` is the long-term transaction seam.
