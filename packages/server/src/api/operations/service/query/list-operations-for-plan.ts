/**
 * Plan-scoped audit query — all sync events for one plan, no sliding window cap.
 */

import * as db from "../../../../infra/persistence/sqlite.js"
import { mapDbEventsAsc } from "./build-operations-from-events.js"
import { buildSyncRunPipeline } from "./pipelines/sync-run.js"
import type { OperationPipeline } from "./types.js"

export async function listOperationsForPlan(planId: string): Promise<{
  operation: OperationPipeline | null
  scannedEvents: number
}> {
  const rows = await db.listEventsForPlanId(planId)
  if (rows.length === 0) return { operation: null, scannedEvents: 0 }

  const events = await mapDbEventsAsc(rows)
  return {
    operation: await buildSyncRunPipeline(planId, events),
    scannedEvents: rows.length
  }
}
