# ports

Contracts owned by `@mia/sync` (say **sync ports** — not server/agent ports).

- `*Host` slices, `*Sink`s
- Tool / `ExecutableTool` shapes (structural with `@mia/agent`)
- `MssqlPoolProvider` (declared here so sync does not depend on agent)
- `WarehouseDialect` — warehouse SQL shape (mssql / postgres adapters); pure
  changeSet core stays dialect-free. Implementations under `adapters/*/dialect/`

No implementations.

Shared quoting / literals / transient-error helpers: `@mia/sql-kit`.
