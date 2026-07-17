/**
 * Run-scoped audit query — all events for one agent run, no sliding window cap.
 */

import * as db from "../../../../infra/persistence/sqlite.js"
import { mapDbEventsAsc } from "./build-operations-from-events.js"
import { buildAgentRunPipeline } from "./pipelines/agent-run.js"
import type { OperationPipeline } from "./types.js"

export function listOperationsForRun(runId: string): {
  operation: OperationPipeline | null
  scannedEvents: number
} {
  const rows = db.listEventsForRunId(runId)
  if (rows.length === 0) return { operation: null, scannedEvents: 0 }

  const events = mapDbEventsAsc(rows)
  return {
    operation: buildAgentRunPipeline(runId, events),
    scannedEvents: rows.length
  }
}
