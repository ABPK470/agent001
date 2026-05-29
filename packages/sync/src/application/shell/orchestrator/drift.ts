/**
 * `revalidatePlanDrift` — re-counts source rows for tables with non-zero
 * diff in the saved plan and reports the maximum relative drift. Used
 * by `executeSync` to abort when the source has shifted >5% since the
 * preview was built.
 *
 * @module
 */

import { EventType, getPool, type AgentHost } from "../../../ports/index.js"
import { type SyncPlan } from "../plan-store.js"
import { emitSyncEvent as emit } from "../events.js"
import { qtable } from "./db-helpers.js"

/**
 * Re-validate the plan against the CURRENT source state by re-counting rows
 * for every table with non-zero diff in the preview. Returns the maximum
 * relative drift (0 = perfect match) or null when nothing to check.
 *
 * Cheap: one COUNT(*) per affected table; bounded by recipe size.
 */
export async function revalidatePlanDrift(host: AgentHost, plan: SyncPlan): Promise<number | null> {
  const affected = plan.tables.filter(
    (t) => t.counts.insert + t.counts.update + t.counts.delete > 0,
  )
  if (affected.length === 0) return null
  const { pool } = await getPool(host, plan.source)
  let maxDrift = 0
  for (const t of affected) {
    try {
      const r = await pool.request().query(
        `SELECT COUNT(*) AS cnt FROM ${qtable(t.table)} WITH (NOLOCK) WHERE ${t.scopePredicate}`,
      )
      const currentCount = (r.recordset[0]?.cnt as number | undefined) ?? 0
      // Reference: source rows expected = unchanged + insert + update (everything in source scope).
      const expected = t.counts.unchanged + t.counts.insert + t.counts.update
      if (expected === 0) continue
      const drift = Math.abs(currentCount - expected) / Math.max(expected, 1)
      if (drift > maxDrift) maxDrift = drift
    } catch (e) {
      console.warn(`[sync.drift-revalidate] ${t.table}: ${e instanceof Error ? e.message : e}`)
    }
  }
  emit(host, EventType.SyncExecuteDriftRevalidated, { planId: plan.planId, maxDriftPct: maxDrift })
  return maxDrift
}
