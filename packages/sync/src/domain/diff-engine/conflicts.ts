/**
 * Scope-misattribution detection for the diff engine.
 *
 * @module
 */

import type { AuthoredSyncDefinitionTable } from "@mia/shared-types"
import type { SyncPlanConflict } from "../../application/shell/plan-store.js"
import type { SyncRuntimeHost } from "../../ports/index.js"
import { formatScalar, qtable, quoteValue, runQueryWithRetry } from "./sql-helpers.js"
import type { PkHashRow } from "./types.js"

/**
 * For every PK that source classifies as INSERT, look up the row on TARGET
 * regardless of scope. If the row exists on target with a DIFFERENT scope
 * value than the one source expects, it's a misattribution: someone
 * associated this row with a different parent on target. Such a row CANNOT
 * be inserted (PK conflict) and silently breaks the user's mental model
 * ("everything from my source pipeline should land 1:1 on target").
 *
 * Limitations:
 *  - Single-column PK only (composite PKs require row-constructor IN clauses
 *    that mssql doesn't always handle cleanly across drivers).
 *  - Recipe must declare a `scopeColumn` that is a real column on the table
 *    (not a sub-query alias) — this is true for all 6 ABI recipes.
 *  - Capped at 5_000 PKs per query to keep the IN list reasonable.
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
): Promise<SyncPlanConflict[]> {
  if (insertCandidates.length === 0) return []
  if (pkColumns.length !== 1) return []
  if (!table.scopeColumn) return []
  // Skip when the predicate references the PK directly — that's the root
  // table's own row and there's no separate parent scope to mismatch against.
  if (table.scopeColumn === pkColumns[0]) return []

  const pkCol = pkColumns[0]!
  const scopeCol = table.scopeColumn
  // Take a hard cap to bound the IN list size.
  const candidates = insertCandidates.slice(0, 5_000)
  const pkLiterals = candidates.map((r) => quoteValue(r.pkValues[pkCol])).join(", ")

  let result: Awaited<ReturnType<typeof runQueryWithRetry>>
  try {
    result = await runQueryWithRetry(
      host,
      targetConn,
      // No NOLOCK (consistent with the rest of diff). Plain READ COMMITTED.
      `SELECT [${pkCol}] AS pk, [${scopeCol}] AS scope ` +
        `FROM ${qtable(table.name)} WHERE [${pkCol}] IN (${pkLiterals})`,
      `detectScopeMisattribution(${table.name})`,
      2,
      telemetryContext
    )
  } catch (e) {
    // Defence-in-depth: if the conflict probe itself fails (transient or
    // permissions), don't block the whole preview — surface as a warning by
    // returning empty here; the caller's normal warnings path is unaffected.
    console.warn(`[sync.diff] scope-misattribution probe failed for ${table.name}:`, e)
    return []
  }

  if (result.recordset.length === 0) return []

  // What scope value SHOULD these rows have? Source-side row carries the
  // expected scope value — but we didn't fetch it (only PK + hash). For most
  // ABI recipes the expected scope is the entityId itself (e.g. pipelineId
  // = entityId). For nested recipes the expected scope is whatever value
  // satisfies the source predicate; we surface the entityId + the recipe's
  // scopeColumn as the "expected" context so the user has actionable info.
  const expectedScope: Record<string, unknown> = {
    [scopeCol]: `(per source predicate using entityId=${entityId})`
  }

  const conflicts: SyncPlanConflict[] = []
  for (const row of result.recordset as Array<{ pk: unknown; scope: unknown }>) {
    const pkValue = row.pk
    const actualScopeValue = row.scope
    conflicts.push({
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
  void sampleSize // counts must be accurate; UI slices for display
  return conflicts
}
