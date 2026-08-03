# Platform schema toolkit

Track B of the RDBMS-agnostic program: typed SQL under
`server/infra/persistence` only (not Sync/Agent cores).

**Honest status:** you cannot set `MIA_PLATFORM_STORE=mssql` yet. SQLite remains
the only platform adapter. Kysely cutover + a multi-dialect migrator are the
path to a real swap. Sync warehouse `mssql|postgres` is a separate concern
(connectors / `WarehouseDialect`).

## Shape

| Piece | Role |
| --- | --- |
| `tables.ts` | Column contracts (`PlatformDatabase`) |
| `kysely.ts` | Process-wide `Kysely` over the SQLite file |
| `execute.ts` | Compile → better-sqlite3 sync execute |
| Repos (`adapters/sqlite/db/*`) | Migrate table-by-table onto the toolkit |

## Cutover tables

- `connectors`
- `users`
- `sync_environments`

DDL still lives in numbered SQLite migrations. Next: more repos, then a
multi-dialect migrator and a real `mssql`/`postgres` `PlatformStore` adapter.

## Rules

- Platform store and warehouse Sync never share a pool.
- `assertPlatformStoreReady()` fails fast for unimplemented kinds at boot.
- Async `PlatformStore.transactionAsync` is the long-term transaction seam.
