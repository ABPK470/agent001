/**
 * Run access control — single source of truth for "can this session see/act on
 * this run?". Admins see everything; visitors see runs they own (matched by
 * UPN if they have one, else by session_id).
 */

import type { CurrentSession } from "./context.js"

export interface RunOwnerFields {
  upn?: string | null
  session_id?: string | null
}

export function canAccessRun(session: CurrentSession | null | undefined, run: RunOwnerFields | null | undefined): boolean {
  if (!session || !run) return false
  if (session.isAdmin) return true
  if (session.upn && run.upn && run.upn.toLowerCase() === session.upn.toLowerCase()) return true
  if (!session.upn && session.sid && run.session_id === session.sid) return true
  return false
}
