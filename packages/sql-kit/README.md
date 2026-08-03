# @mia/sql-kit

Shared **relational** SQL helpers for Mia:

- Identifier / table quoting (MSSQL, Postgres, Oracle)
- Value literals
- Transient executor error taxonomy
- Warehouse pool provider *shape* (not a global pool)

Not an ORM. Not Sync MERGE. Not the platform schema toolkit.

Used by `@mia/connectors` (Bridge), `@mia/sync` (warehouse), and
`@mia/server` (platform store ports). See `docs/doctrine.md` §5c.
