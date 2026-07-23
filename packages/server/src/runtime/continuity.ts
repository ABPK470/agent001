/**
 * Continuity contract — single rule for cross-turn agent grounding.
 *
 *   thread_id  → which conversation/workspace prior turns & tool results belong to
 *   upn        → who owns the data (access control)
 * Auth login cookies live in the `sessions` table only — not copied onto runs
 * or memory rows. Agent context never keys on cookie sid.
 *
 * Every authenticated run MUST carry an explicit thread_id chosen by the client.
 * The server does not mint threads, does not fall back to session scope, and does
 * not guess continuity from the browser cookie.
 */

import * as db from "../infra/persistence/sqlite.js"

export class ContinuityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ContinuityError"
  }
}

/** Resolve and validate a client-supplied thread id for the authenticated user. */
export function requireOwnedThreadId(threadId: string | undefined, upn: string): string {
  const id = threadId?.trim()
  if (!id) throw new ContinuityError("threadId is required")
  const thread = db.getThread(id)
  if (!thread || thread.upn.toLowerCase() !== upn.toLowerCase()) {
    throw new ContinuityError(`thread not found: ${id}`)
  }
  return thread.id
}
