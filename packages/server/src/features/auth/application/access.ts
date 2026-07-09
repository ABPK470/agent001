/**
 * Run access control — single source of truth for "can this session see/act
 * on this run?".
 *
 * v19: identity is verified, every session has a real upn, and every run
 * row has a NOT NULL upn FK. So access reduces to two cases:
 *   - admin → sees everything
 *   - else  → sees runs where run.upn === session.upn
 *
 * The previous anon branch (run.session_id === session.sid) is gone — anon
 * sessions no longer exist post-v19, and binding access to sid would mean
 * losing visibility on logout/re-login of the same user from a new tab.
 */

import type { CurrentSession } from "../runtime/context.js"

/** Thrown when an agent/run endpoint is called without a logged-in user. */
export class AuthRequiredError extends Error {
  constructor(message = "Authentication required") {
    super(message)
    this.name = "AuthRequiredError"
  }
}

/** Every agent run requires a verified user identity (upn). */
export function requireSessionUpn(session: CurrentSession | null | undefined): string {
  const upn = session?.upn?.trim()
  if (!upn) throw new AuthRequiredError()
  return upn
}

export interface RunOwnerFields {
  upn?: string | null
}

export function canAccessRun(
  session: CurrentSession | null | undefined,
  run: RunOwnerFields | null | undefined
): boolean {
  if (!session || !run) return false
  if (session.isAdmin) return true
  if (run.upn && run.upn.toLowerCase() === session.upn.toLowerCase()) return true
  return false
}
