/**
 * Personal event visibility under Viewing as.
 *
 * One dialect for live SSE fanout and historical `/api/events` list/search.
 * Include when ownership is unknown or matches viewingAsUpn; exclude when
 * ownership is known and differs.
 */

import { getRun, getSyncRun } from "../persistence/sqlite.js"
import { sameUpn } from "../../internal/upn.js"

export function ownerFromEventData(data: Record<string, unknown>): string | null {
  for (const key of ["actorUpn", "upn", "userUpn"] as const) {
    const value = data[key]
    if (typeof value === "string" && value.trim()) return value.trim()
  }

  const runId = typeof data["runId"] === "string" ? data["runId"] : null
  if (runId) {
    const run = getRun(runId)
    if (run?.upn?.trim()) return run.upn.trim()
  }

  const planId = typeof data["planId"] === "string" ? data["planId"] : null
  if (planId) {
    const syncRun = getSyncRun(planId)
    if (syncRun?.actor_upn?.trim()) return syncRun.actor_upn.trim()
  }

  return null
}

export function eventMatchesViewingAs(
  data: Record<string, unknown>,
  viewingAsUpn: string,
): boolean {
  const owner = ownerFromEventData(data)
  if (!owner) return true
  return sameUpn(owner, viewingAsUpn)
}
