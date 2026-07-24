/**
 * Run access control — Personal visibility under Viewing as.
 *
 * Access: run.upn must equal viewingAsUpn.
 * Writes: only when Viewing as Me (see requirePersonalWrite).
 */

import type { CurrentSession } from "../state/context.js"
import { canAccessOwned, type ViewingAs } from "./viewing-as.js"

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
  viewingAs: ViewingAs | null | undefined,
  run: RunOwnerFields | null | undefined,
): boolean {
  if (!viewingAs || !run) return false
  return canAccessOwned(viewingAs, run.upn)
}
