# MSSQL WarehouseDialect

Target home for Sync warehouse SQL extracted from `runtime/` and
`core/diff-engine` (MERGE, HASHBYTES, catalog/`sys.*`, identity, constraint
relax).

Milestone: implement `WarehouseDialect` here with **zero behavior change**,
then wire the orchestrator through the port. Postgres peer lands under
`adapters/postgres/dialect/`.
