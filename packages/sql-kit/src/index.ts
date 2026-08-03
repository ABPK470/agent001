/**
 * @mia/sql-kit — shared relational SQL helpers.
 *
 * Quoting, literals, transient errors, pool *shape*.
 * Not an ORM. Not Sync MERGE. Not the platform schema toolkit.
 */

export {
  quoteMssqlIdent,
  quoteMssqlTable,
  quoteOracleIdent,
  quoteOracleTable,
  quotePgIdent,
  quotePgTable,
  splitOracleTable,
} from "./idents.js"

export { quoteSqlLiteral } from "./literals.js"

export { isTransientMssqlError, isTransientSqlError } from "./errors.js"

export type {
  RelationalDialectKind,
  SqlPoolHandle,
  WarehouseDialectKind,
  WarehousePoolProvider,
} from "./pool.js"
