/**
 * Materialize published SCD2 templates against live table columns at preview time.
 */

import type { AuthoredSyncDefinitionTable } from "@mia/shared-types"
import {
  formatScd2PolicyOmissionSummary,
  materializeScd2PolicyForSchema,
} from "./scd2-policy.js"

export interface MaterializedDefinitionTable extends AuthoredSyncDefinitionTable {
  scd2Policy?: AuthoredSyncDefinitionTable["scd2Policy"]
}

export function materializeDefinitionTablesForSchema(
  tables: readonly AuthoredSyncDefinitionTable[],
  sourceColumnsByTable: Map<string, string[]>,
  targetColumnsByTable: Map<string, string[]>,
): { tables: MaterializedDefinitionTable[]; omissionSummaries: string[] } {
  const omissionSummaries: string[] = []
  const materialized: MaterializedDefinitionTable[] = []

  for (const table of tables) {
    if (!table.scd2Policy) {
      materialized.push({ ...table })
      continue
    }
    const sourceColumns = sourceColumnsByTable.get(table.name) ?? []
    const targetColumns = targetColumnsByTable.get(table.name) ?? []
    const { policy, omitted } = materializeScd2PolicyForSchema(
      table.scd2Policy,
      sourceColumns,
      targetColumns,
    )
    const summary = formatScd2PolicyOmissionSummary(table.name, omitted)
    if (summary) omissionSummaries.push(summary)
    materialized.push({ ...table, scd2Policy: policy })
  }

  return { tables: materialized, omissionSummaries }
}
