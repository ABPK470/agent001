/**
 * FK constraint relaxation for metadata apply (NOCHECK / CHECK ALL).
 */

import { quoteMssqlTable } from "@mia/sql-kit"

export function mssqlDisableConstraintsSql(qualifiedTable: string): string {
  return `ALTER TABLE ${quoteMssqlTable(qualifiedTable)} NOCHECK CONSTRAINT ALL`
}

export function mssqlEnableConstraintsSql(qualifiedTable: string): string {
  return `ALTER TABLE ${quoteMssqlTable(qualifiedTable)} CHECK CONSTRAINT ALL`
}
