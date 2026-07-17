import { useCallback, useLayoutEffect, useRef, useState } from "react"

const STORAGE_PREFIX = "mia:composer-draft:"

function storageKey(threadId: string | null): string | null {
  if (!threadId) return null
  return `${STORAGE_PREFIX}${threadId}`
}

function readStoredDraft(threadId: string | null): string {
  const key = storageKey(threadId)
  if (!key) return ""
  try {
    return sessionStorage.getItem(key) ?? ""
  } catch {
    return ""
  }
}

function writeStoredDraft(threadId: string | null, text: string): void {
  const key = storageKey(threadId)
  if (!key) return
  try {
    if (text) sessionStorage.setItem(key, text)
    else sessionStorage.removeItem(key)
  } catch {
    /* quota / private mode */
  }
}

/**
 * Per-thread composer text — React state is the sole source of truth.
 * Drafts are persisted to sessionStorage on every change and rehydrated
 * when the active thread changes or the page reloads.
 */
export function useComposerDraft(threadId: string | null) {
  const [draft, setDraftState] = useState("")
  const loadedThreadRef = useRef<string | null | undefined>(undefined)

  useLayoutEffect(() => {
    if (loadedThreadRef.current === threadId) return
    loadedThreadRef.current = threadId
    setDraftState(readStoredDraft(threadId))
  }, [threadId])

  const setDraft = useCallback(
    (next: string | ((prev: string) => string)) => {
      setDraftState((prev) => {
        const value = typeof next === "function" ? next(prev) : next
        writeStoredDraft(threadId, value)
        return value
      })
    },
    [threadId],
  )

  const clearDraft = useCallback(() => {
    writeStoredDraft(threadId, "")
    setDraftState("")
  }, [threadId])

  return { draft, setDraft, clearDraft }
}
