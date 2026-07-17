/**
 * Post-open database maintenance — run once at server boot after {@link openDatabase}.
 *
 * Hygiene only (status normalisation, retention pruning). Auth bootstrap is separate
 * in start-server because it is an application concern, not persistence internals.
 */

import { pruneExpiredAttachments } from "./attachments.js"
import { getDbPath } from "./connection.js"
import { normaliseUnknownRunStatuses } from "./db/runs.js"
import { pruneOldData } from "./db/lifecycle.js"
import { prune as pruneMemory } from "./memory.js"

export function runDatabaseMaintenance(): void {
  console.log(`Database opened (${getDbPath()})`)

  const normalised = normaliseUnknownRunStatuses()
  if (normalised > 0) {
    console.log(`Normalised ${normalised} runs with unknown legacy statuses to 'failed'`)
  }

  const pruneResult = pruneOldData()
  if (pruneResult.prunedRuns > 0 || pruneResult.prunedApiRequests > 0) {
    console.log(
      `Pruned ${pruneResult.prunedRuns} old runs, ${pruneResult.prunedApiRequests} API request logs`
    )
  }

  const attachmentPrune = pruneExpiredAttachments()
  if (attachmentPrune.prunedAttachments > 0) {
    console.log(`Pruned ${attachmentPrune.prunedAttachments} expired attachments (retention TTL)`)
  }

  const memPrune = pruneMemory()
  if (memPrune.deleted > 0) {
    console.log(`Pruned ${memPrune.deleted} stale/duplicate memory entries`)
  }
}
