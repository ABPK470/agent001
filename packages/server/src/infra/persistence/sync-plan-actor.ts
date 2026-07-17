/**
 * Resolve the authenticated actor for sync-run persistence.
 *
 * Preview/execute callers stamp `userUpn` on the plan's governance decision;
 * the run sink must persist that UPN (a real `users.upn` row) — never a
 * display placeholder like "anonymous".
 */
export function syncPlanActorUpn(plan: {
  governanceDecision?: { targetEnvironment?: { actorUpn?: string | null } } | null
}): string | null {
  const upn = plan.governanceDecision?.targetEnvironment?.actorUpn
  return typeof upn === "string" && upn.trim().length > 0 ? upn.trim() : null
}

export function requireSyncRunActorUpn(actorUpn: string | null | undefined, context: string): string {
  const upn = typeof actorUpn === "string" ? actorUpn.trim() : ""
  if (!upn) {
    throw new Error(`${context}: actor UPN is required (must reference users.upn)`)
  }
  return upn
}
