# MSSQL WarehouseDialect

Owns Sync warehouse SQL for SQL Server:

| Module | SQL |
| --- | --- |
| `hash.ts` | HASHBYTES fingerprint SELECT + culture-invariant CONVERT |
| `session.ts` | Deterministic session SET prefix |
| `catalog.ts` | `sys.columns` / PK probes |
| `upsert.ts` | `#syncSrc` + MERGE + IDENTITY_INSERT |
| `delete.ts` | `#syncDelPk` + DELETE |

Factory: `createMssqlWarehouseDialect()` — wired on `SyncHost.warehouseDialect`.
Postgres peer lands under `adapters/postgres/dialect/`.
