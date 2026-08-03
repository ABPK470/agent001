/**
 * Postgres WarehouseDialect — Sync warehouse SQL peer to MSSQL.
 *
 * Caps: no mssql_procedure, no identity_insert (uses OVERRIDING SYSTEM VALUE
 * in upsert SQL when requested), no constraint_relax until apply wiring lands.
 */

import {
  quotePgIdent,
  quotePgTable,
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
  pgHashColumnsMetaSql,
  pgInboundForeignKeysSql,
  pgInformationSchemaColumnsBySchemasSql,
  pgInformationSchemaColumnsByTablesSql,
  pgOutboundForeignKeysSql,
  pgPrimaryKeySql,
  pgRootTableColumnsSql,
  pgTableColumnNamesSql,
  pgTableHasTriggersSql,
  pgTargetColumnsSql,
} from "./catalog.js"
import { pgDisableConstraintsSql, pgEnableConstraintsSql } from "./constraints.js"
import { pgDeleteBatchSql } from "./delete.js"
import { pgHashSelectSql } from "./hash.js"
import { POSTGRES_DETERMINISTIC_SESSION_PREFIX } from "./session.js"
import { pgUpsertBatchSql } from "./upsert.js"

const PG_CAPS = new Set<WarehouseCapability>(["temp_tables"])

export function createPostgresWarehouseDialect(): WarehouseDialect {
  return {
    kind: "postgres",

    supports(capability: WarehouseCapability): boolean {
      return PG_CAPS.has(capability)
    },

    quoteIdent: quotePgIdent,
    quoteTable: quotePgTable,
    quoteLiteral: quoteSqlLiteral,

    sessionPrefixSql(): string {
      return POSTGRES_DETERMINISTIC_SESSION_PREFIX
    },

    utcNowExpr(): string {
      return `(NOW() AT TIME ZONE 'utc')`
    },

    readFromHintSql(): string {
      return ""
    },

    hashSelectSql(input: WarehouseHashSelectInput): string {
      return pgHashSelectSql(input)
    },

    targetColumnsSql(qualifiedTable: string): string {
      return pgTargetColumnsSql(qualifiedTable)
    },

    primaryKeySql(qualifiedTable: string): string {
      return pgPrimaryKeySql(qualifiedTable)
    },

    hashColumnsMetaSql(qualifiedTable: string): string {
      return pgHashColumnsMetaSql(qualifiedTable)
    },

    informationSchemaColumnsBySchemasSql(schemas: readonly string[]): string {
      return pgInformationSchemaColumnsBySchemasSql(schemas)
    },

    informationSchemaColumnsByTablesSql(tables: readonly string[]): string {
      return pgInformationSchemaColumnsByTablesSql(tables)
    },

    tableColumnNamesSql(qualifiedTable: string): string {
      return pgTableColumnNamesSql(qualifiedTable)
    },

    tableHasTriggersSql(qualifiedTable: string): string {
      return pgTableHasTriggersSql(qualifiedTable)
    },

    inboundForeignKeysSql(qualifiedTable: string): string {
      return pgInboundForeignKeysSql(qualifiedTable)
    },

    outboundForeignKeysSql(qualifiedTable: string): string {
      return pgOutboundForeignKeysSql(qualifiedTable)
    },

    rootTableColumnsSql(schema: string, table: string): string {
      return pgRootTableColumnsSql(schema, table)
    },

    disableConstraintsSql(qualifiedTable: string): string {
      return pgDisableConstraintsSql(qualifiedTable)
    },

    enableConstraintsSql(qualifiedTable: string): string {
      return pgEnableConstraintsSql(qualifiedTable)
    },

    upsertBatchSql(input: WarehouseUpsertSqlInput): string {
      return pgUpsertBatchSql(input)
    },

    deleteBatchSql(input: WarehouseDeleteSqlInput): string {
      return pgDeleteBatchSql(input)
    },
  }
}

export { POSTGRES_DETERMINISTIC_SESSION_PREFIX } from "./session.js"
