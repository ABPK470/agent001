import type { CurrentSession } from "../runtime/context.js"

export interface ThreadOwnerFields {
  upn: string
}

export function canAccessThread(
  session: CurrentSession | null | undefined,
  thread: ThreadOwnerFields | null | undefined
): boolean {
  if (!session || !thread) return false
  if (session.isAdmin) return true
  return thread.upn.toLowerCase() === session.upn.toLowerCase()
}
