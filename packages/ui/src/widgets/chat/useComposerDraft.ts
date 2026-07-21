import { useCallback, useLayoutEffect, useRef, useState } from "react"
import {
  readComposerDraft,
  writeComposerDraft,
} from "./composerDraftStorage"

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
    setDraftState(readComposerDraft(threadId))
  }, [threadId])

  const setDraft = useCallback(
    (next: string | ((prev: string) => string)) => {
      setDraftState((prev) => {
        const value = typeof next === "function" ? next(prev) : next
        writeComposerDraft(threadId, value)
        return value
      })
    },
    [threadId],
  )

  const clearDraft = useCallback(() => {
    writeComposerDraft(threadId, "")
    setDraftState("")
  }, [threadId])

  return { draft, setDraft, clearDraft }
}
