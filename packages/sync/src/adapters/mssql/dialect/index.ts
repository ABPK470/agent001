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
import {
  mssqlHashColumnsMetaSql,
  mssqlInboundForeignKeysSql,
  mssqlInformationSchemaColumnsBySchemasSql,
  mssqlInformationSchemaColumnsByTablesSql,
  mssqlOutboundForeignKeysSql,
  mssqlPrimaryKeySql,
  mssqlRootTableColumnsSql,
  mssqlTableColumnNamesSql,
  mssqlTableHasTriggersSql,
  mssqlTargetColumnsSql,
} from "./catalog.js"
import { mssqlDisableConstraintsSql, mssqlEnableConstraintsSql } from "./constraints.js"
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

    readFromHintSql(): string {
      return " WITH (NOLOCK)"
    },

    selectLimitPrefixSql(limit: number): string {
      return `TOP (${Math.max(0, Math.floor(limit))}) `
    },

    selectLimitSuffixSql(_limit: number): string {
      return ""
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

    hashColumnsMetaSql(qualifiedTable: string): string {
      return mssqlHashColumnsMetaSql(qualifiedTable)
    },

    informationSchemaColumnsBySchemasSql(schemas: readonly string[]): string {
      return mssqlInformationSchemaColumnsBySchemasSql(schemas)
    },

    informationSchemaColumnsByTablesSql(tables: readonly string[]): string {
      return mssqlInformationSchemaColumnsByTablesSql(tables)
    },

    tableColumnNamesSql(qualifiedTable: string): string {
      return mssqlTableColumnNamesSql(qualifiedTable)
    },

    tableHasTriggersSql(qualifiedTable: string): string {
      return mssqlTableHasTriggersSql(qualifiedTable)
    },

    inboundForeignKeysSql(qualifiedTable: string): string {
      return mssqlInboundForeignKeysSql(qualifiedTable)
    },

    outboundForeignKeysSql(qualifiedTable: string): string {
      return mssqlOutboundForeignKeysSql(qualifiedTable)
    },

    rootTableColumnsSql(schema: string, table: string): string {
      return mssqlRootTableColumnsSql(schema, table)
    },

    disableConstraintsSql(qualifiedTable: string): string {
      return mssqlDisableConstraintsSql(qualifiedTable)
    },

    enableConstraintsSql(qualifiedTable: string): string {
      return mssqlEnableConstraintsSql(qualifiedTable)
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
