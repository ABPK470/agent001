/**
 * Personal event visibility under Viewing as.
 *
 * Live SSE fanout uses the hot path only (stamped actorUpn / in-memory index).
 * Historical list/search may resolve legacy rows via DB when columns are empty.
 */

import { getRun, getSyncRun } from "../persistence/sqlite.js"
import { sameUpn } from "../../internal/upn.js"
import {
  eventMatchesViewingAsHot,
  ownerFromEventDataHot,
} from "../../ports/run-owner-index.js"

export { eventMatchesViewingAsHot, ownerFromEventDataHot }

/** Prefer stamps; fall back to DB for legacy event_log rows without actorUpn. */
export async function ownerFromEventData(data: Record<string, unknown>): Promise<string | null> {
  const hot = ownerFromEventDataHot(data)
  if (hot) return hot

  const runId = typeof data["runId"] === "string" ? data["runId"] : null
  if (runId) {
    const run = await getRun(runId)
    if (run?.upn?.trim()) return run.upn.trim().toLowerCase()
  }

  const planId = typeof data["planId"] === "string" ? data["planId"] : null
  if (planId) {
    const syncRun = await getSyncRun(planId)
    if (syncRun?.actor_upn?.trim()) return syncRun.actor_upn.trim().toLowerCase()
  }

  return null
}

export async function eventMatchesViewingAs(
  data: Record<string, unknown>,
  viewingAsUpn: string,
): Promise<boolean> {
  const owner = await ownerFromEventData(data)
  if (!owner) return true
  return sameUpn(owner, viewingAsUpn)
}

/** Live SSE — never touches SQLite. */
export function eventMatchesViewingAsLive(
  data: Record<string, unknown>,
  viewingAsUpn: string,
): boolean {
  return eventMatchesViewingAsHot(data, viewingAsUpn)
}
