/**
 * On startup, mark proposer runs that were still pending/running as cancelled
 * and broadcast so Pipelines / Sync Admin settle immediately.
 */

import { EventType } from "@mia/shared-enums"
import { broadcast } from "../../../infra/events/broadcaster.js"
import {
  findStaleProposerRuns,
  finishProposerRun,
} from "../../../infra/persistence/proposals.js"
import { cancelOperation } from "../../../infra/operations/cancel-registry.js"

export function recoverStaleProposerRuns(): string[] {
  const stale = findStaleProposerRuns()
  const cancelled: string[] = []

  for (const row of stale) {
    cancelOperation("proposer.run", row.id, "Server restarted — run interrupted")
    finishProposerRun({
      id: row.id,
      status: "cancelled",
      counts: { scanned: row.scanned, produced: row.produced, errors: row.errors },
      durationMs: row.duration_ms ?? 0,
      error: "Server restarted — run interrupted",
    })
    broadcast({
      type: EventType.SyncProposerRunCancelled,
      data: {
        runId: row.id,
        envPair: { source: row.source, target: row.target },
        reason: "Server restarted — run interrupted",
      },
    })
    cancelled.push(row.id)
  }

  return cancelled
}
