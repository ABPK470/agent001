/**
 * Scope-misattribution detection for the diff engine.
 *
 * @module
 */

import type { AuthoredSyncDefinitionTable } from "@mia/shared-types"
import type { SyncPlanConflict } from "../../domain/plan.js"
import { formatScalar, qtable, quoteValue } from "../../core/diff-engine/sql-helpers.js"
import type { PkHashRow } from "../../domain/diff-engine/types.js"
import type { SyncRuntimeHost } from "../../ports/index.js"
import { runQueryWithRetry } from "./sql-query.js"

export interface ScopeMisattributionResult {
  conflicts: SyncPlanConflict[]
  /** Probe I/O failure — never silent; caller attaches to table/plan warnings. */
  warnings: string[]
}

/**
 * For every PK that source classifies as INSERT, look up the row on TARGET
 * regardless of scope. If the row exists on target with a DIFFERENT scope
 * value than the one source expects, it's a misattribution.
 *
 * Limitations: single-column PK; recipe scopeColumn must be a real column;
 * capped at 5_000 PKs per query.
 */
export async function detectScopeMisattribution(
  host: SyncRuntimeHost,
  targetConn: string,
  table: Pick<AuthoredSyncDefinitionTable, "name" | "scopeColumn" | "predicate">,
  entityId: string | number,
  pkColumns: string[],
  insertCandidates: PkHashRow[],
  sampleSize: number,
  telemetryContext?: import("../../ports/events.js").SyncTelemetryContext
): Promise<ScopeMisattributionResult> {
  if (insertCandidates.length === 0) return { conflicts: [], warnings: [] }
  if (pkColumns.length !== 1) return { conflicts: [], warnings: [] }
  if (!table.scopeColumn) return { conflicts: [], warnings: [] }
  if (table.scopeColumn === pkColumns[0]) return { conflicts: [], warnings: [] }

  const pkCol = pkColumns[0]!
  const scopeCol = table.scopeColumn
  const candidates = insertCandidates.slice(0, 5_000)
  const pkLiterals = candidates.map((r) => quoteValue(r.pkValues[pkCol])).join(", ")

  let result: Awaited<ReturnType<typeof runQueryWithRetry>>
  try {
    result = await runQueryWithRetry(
      host,
      targetConn,
      `SELECT [${pkCol}] AS pk, [${scopeCol}] AS scope ` +
        `FROM ${qtable(table.name)} WHERE [${pkCol}] IN (${pkLiterals})`,
      `detectScopeMisattribution(${table.name})`,
      2,
      telemetryContext
    )
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.warn(`[sync.diff] scope-misattribution probe failed for ${table.name}:`, e)
    return {
      conflicts: [],
      warnings: [`[conflict-probe] scope-misattribution failed for ${table.name}: ${message}`]
    }
  }

  if (result.recordset.length === 0) return { conflicts: [], warnings: [] }

  const expectedScope: Record<string, unknown> = {
    [scopeCol]: `(per source predicate using entityId=${entityId})`
  }

  const conflicts: SyncPlanConflict[] = []
  for (const row of result.recordset as Array<{ pk: unknown; scope: unknown }>) {
    const pkValue = row.pk
    const actualScopeValue = row.scope
    conflicts.push({
      kind: "scope_misattribution",
      pk: String(pkValue ?? "∅"),
      expectedScope,
      actualScope: { [scopeCol]: actualScopeValue },
      summary:
        `${pkCol}=${formatScalar(pkValue)} exists on target with ` +
        `${scopeCol}=${formatScalar(actualScopeValue)}, but source claims it under the current sync scope ` +
        `(predicate: ${table.predicate.replace("{id}", String(entityId))}). ` +
        `Inserting would violate the PK; execute will refuse until target metadata is corrected.`
    })
  }
  void sampleSize
  return { conflicts, warnings: [] }
}
