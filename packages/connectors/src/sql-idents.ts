/**
 * Re-export shared identifier quoting from @mia/sql-kit.
 * Bridge call sites keep importing from this module / package barrel.
 */

export {
  quoteMssqlIdent,
  quoteMssqlTable,
  quoteOracleIdent,
  quoteOracleTable,
  quotePgIdent,
  quotePgTable,
  splitOracleTable,
} from "@mia/sql-kit"
