/**
 * MSSQL WarehouseDialect — Sync warehouse SQL (zero behavior change extract).
 */

import {
  quoteMssqlIdent,
  quoteMssqlTable,
  quoteSqlLiteral,
} from "@mia/sql-kit"
import type {
  WarehouseCapability,
  WarehouseDeleteSqlInput,
  WarehouseDialect,
  WarehouseHashSelectInput,
  WarehouseUpsertSqlInput,
} from "../../../ports/warehouse-dialect.js"
import { mssqlPrimaryKeySql, mssqlTargetColumnsSql } from "./catalog.js"
import { mssqlDeleteBatchSql } from "./delete.js"
import { mssqlHashSelectSql } from "./hash.js"
import { MSSQL_DETERMINISTIC_SESSION_PREFIX } from "./session.js"
import { mssqlUpsertBatchSql } from "./upsert.js"

const MSSQL_CAPS = new Set<WarehouseCapability>([
  "mssql_procedure",
  "identity_insert",
  "constraint_relax",
  "temp_tables",
])

export function createMssqlWarehouseDialect(): WarehouseDialect {
  return {
    kind: "mssql",

    supports(capability: WarehouseCapability): boolean {
      return MSSQL_CAPS.has(capability)
    },

    quoteIdent: quoteMssqlIdent,
    quoteTable: quoteMssqlTable,
    quoteLiteral: quoteSqlLiteral,

    sessionPrefixSql(): string {
      return MSSQL_DETERMINISTIC_SESSION_PREFIX
    },

    utcNowExpr(): string {
      return "GETUTCDATE()"
    },

    hashSelectSql(input: WarehouseHashSelectInput): string {
      return mssqlHashSelectSql(input)
    },

    targetColumnsSql(qualifiedTable: string): string {
      return mssqlTargetColumnsSql(qualifiedTable)
    },

    primaryKeySql(qualifiedTable: string): string {
      return mssqlPrimaryKeySql(qualifiedTable)
    },

    upsertBatchSql(input: WarehouseUpsertSqlInput): string {
      return mssqlUpsertBatchSql(input)
    },

    deleteBatchSql(input: WarehouseDeleteSqlInput): string {
      return mssqlDeleteBatchSql(input)
    },
  }
}

export { mssqlHashExpr } from "./hash.js"
export { MSSQL_DETERMINISTIC_SESSION_PREFIX } from "./session.js"
