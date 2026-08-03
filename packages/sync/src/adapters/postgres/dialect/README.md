# Postgres WarehouseDialect

Peer to `adapters/mssql/dialect`. Owns Sync warehouse SQL strings for PostgreSQL
(catalog, hash, upsert, delete). Pool execute stays in runtime / host providers.

**v1 capabilities:** no `mssql_procedure`, no `constraint_relax`, no
`identity_insert` flag (upsert uses `OVERRIDING SYSTEM VALUE` when requested).
