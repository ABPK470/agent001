/**
 * Personal event visibility under Viewing as.
 *
 * Include when ownership is unknown (system / platform noise) or matches
 * viewingAsUpn. Exclude when ownership is known and differs.
 */

import { getRun, getSyncRun } from "../../../infra/persistence/sqlite.js"

function sameUpn(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

function ownerFromEventData(data: Record<string, unknown>): string | null {
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
