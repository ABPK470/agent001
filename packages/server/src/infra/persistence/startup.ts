/**
 * Post-open database maintenance — run once at server boot after the platform store opens.
 *
 * Hygiene only (status normalisation, retention pruning). Auth bootstrap is separate
 * in start-server because it is an application concern, not persistence internals.
 */

import { pruneExpiredAttachments } from "./attachments.js"
import { getPlatformDbKind } from "./schema/kysely.js"
import { getDbPath } from "./adapters/sqlite/index.js"
import { normaliseUnknownRunStatuses } from "./adapters/sqlite/db/runs.js"
import { pruneOldData } from "./adapters/sqlite/db/lifecycle.js"
import { prune as pruneMemory } from "./memory.js"

export async function runDatabaseMaintenance(): Promise<void> {
  const kind = getPlatformDbKind()
  if (kind === "sqlite") {
    console.log(`Database opened (${getDbPath()})`)
  } else {
    console.log(`Platform store opened (${kind})`)
  }

  const normalised = await normaliseUnknownRunStatuses()
  if (normalised > 0) {
    console.log(`Normalised ${normalised} runs with unknown legacy statuses to 'failed'`)
  }

  // pruneOldData uses SQLite LIMIT/OFFSET/vacuum idioms — skip on server RDBMS for now.
  if (kind === "sqlite") {
    const pruneResult = await pruneOldData()
    if (pruneResult.prunedRuns > 0 || pruneResult.prunedApiRequests > 0) {
      console.log(
        `Pruned ${pruneResult.prunedRuns} old runs, ${pruneResult.prunedApiRequests} API request logs`,
      )
    }
  }

  const attachmentPrune = await pruneExpiredAttachments()
  if (attachmentPrune.prunedAttachments > 0) {
    console.log(`Pruned ${attachmentPrune.prunedAttachments} expired attachments (retention TTL)`)
  }

  const memPrune = await pruneMemory()
  if (memPrune.deleted > 0) {
    console.log(`Pruned ${memPrune.deleted} stale/duplicate memory entries`)
  }
}
