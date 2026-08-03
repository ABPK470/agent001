# Postgres Sync warehouse adapter

`dialect/` owns WarehouseDialect SQL builders (peer to `adapters/mssql/dialect`).

Pool provider wiring (long-lived `pg.Pool` by connector id) lands next beside
the existing MSSQL pool provider on the server composition root.
