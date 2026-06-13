import { bootstrapAdminFromEnv } from "../features/auth/index.js"
import { pruneExpiredAttachments } from "../platform/persistence/attachments.js"
import {
  getDb,
  getDbPath,
  normaliseUnknownRunStatuses,
  pruneOldData
} from "../platform/persistence/index.js"
import { prune as pruneMemory } from "../platform/persistence/memory.js"

export function initDatabase(): void {
  getDb()
  console.log(`Database initialized (${getDbPath()})`)

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

  bootstrapAdminFromEnv()
}
