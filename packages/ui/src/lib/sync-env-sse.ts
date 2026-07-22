/**
 * SSE tick for sync environment catalog changes (create/update/delete/reset).
 * Configuration and Manual Sync both reload when this count advances.
 */

import { EventType } from "@mia/shared-enums"

export function countSyncEnvSseEvents(log: ReadonlyArray<{ type: unknown }>): number {
  let count = 0
  for (const event of log) {
    const type = String(event.type)
    if (type === EventType.SyncEnvUpdate || type === EventType.SyncEnvReset) count++
  }
  return count
}
