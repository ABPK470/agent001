import { canAccessOwned, type ViewingAs } from "./viewing-as.js"

export interface ThreadOwnerFields {
  upn: string
}

export function canAccessThread(
  viewingAs: ViewingAs | null | undefined,
  thread: ThreadOwnerFields | null | undefined,
): boolean {
  if (!viewingAs || !thread) return false
  return canAccessOwned(viewingAs, thread.upn)
}
