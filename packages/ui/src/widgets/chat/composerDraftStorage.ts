/**
 * Per-thread composer draft persistence (sessionStorage) — pure for tests.
 */

const STORAGE_PREFIX = "mia:composer-draft:"

export function composerDraftStorageKey(threadId: string | null): string | null {
  if (!threadId) return null
  return `${STORAGE_PREFIX}${threadId}`
}

export function readComposerDraft(
  threadId: string | null,
  storage: Pick<Storage, "getItem"> = sessionStorage,
): string {
  const key = composerDraftStorageKey(threadId)
  if (!key) return ""
  try {
    return storage.getItem(key) ?? ""
  } catch {
    return ""
  }
}

export function writeComposerDraft(
  threadId: string | null,
  text: string,
  storage: Pick<Storage, "setItem" | "removeItem"> = sessionStorage,
): void {
  const key = composerDraftStorageKey(threadId)
  if (!key) return
  try {
    if (text) storage.setItem(key, text)
    else storage.removeItem(key)
  } catch (err: unknown) { console.error("[mia]", err) }
}
