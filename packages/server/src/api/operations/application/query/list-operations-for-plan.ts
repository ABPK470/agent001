/**
 * Plan-scoped audit query — all sync events for one plan, no sliding window cap.
 */

import * as db from "../../../../platform/persistence/sqlite.js"
import { mapDbEventsAsc } from "./build-operations-from-events.js"
import { buildSyncRunPipeline } from "./pipelines/sync-run.js"
import type { OperationPipeline } from "./types.js"

export function listOperationsForPlan(planId: string): {
  operation: OperationPipeline | null
  scannedEvents: number
} {
  const rows = db.listEventsForPlanId(planId)
  if (rows.length === 0) return { operation: null, scannedEvents: 0 }

  const events = mapDbEventsAsc(rows)
  return {
    operation: buildSyncRunPipeline(planId, events),
    scannedEvents: rows.length
  }
}
