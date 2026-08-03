/**
 * Postgres constraint relaxation — session_replication_role (capability-gated).
 *
 * Per-table NOCHECK has no direct peer; Sync v1 uses replica role when the
 * dialect advertises constraint_relax. Disabled by default on the PG dialect.
 */

import { quotePgTable } from "@mia/sql-kit"

export function pgDisableConstraintsSql(qualifiedTable: string): string {
  // Table-scoped placeholder for capability-gated call sites / tests.
  return `ALTER TABLE ${quotePgTable(qualifiedTable)} DISABLE TRIGGER USER`
}

export function pgEnableConstraintsSql(qualifiedTable: string): string {
  return `ALTER TABLE ${quotePgTable(qualifiedTable)} ENABLE TRIGGER USER`
}
