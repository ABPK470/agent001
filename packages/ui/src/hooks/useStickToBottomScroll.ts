import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { isNearBottom, scrollHostToBottom } from "../lib/chatScroll"

export interface UseStickToBottomScrollOptions {
  /** Pixels from bottom to still count as "following" live output. */
  threshold?: number
  /**
   * When this changes after mount (e.g. user just started a new run), jump to
   * bottom once. Do NOT pass ambient active-run ids — that causes scroll frenzy
   * when the chat surface remounts (home ↔ widgets).
   */
  resetKey?: string | null
  /** Whether to jump to bottom on first mount. Prefer `none` for home chat. */
  initialScroll?: "none" | "bottom"
  onScrollPosition?: (scrollTop: number, host: HTMLDivElement) => void
  /**
   * When false, growing content does not auto-scroll even if the user is at
   * the bottom. Use while idle so historical hydration / trace patches do not
   * yank the viewport. Live generation should pass true.
   */
  followWhen?: boolean
}

export type ScrollToBottomOptions = {
  /** When false, jump without enabling live follow (avoids resize yank after hydrate). */
  stick?: boolean
}

export function useStickToBottomScroll(options: UseStickToBottomScrollOptions = {}) {
  const {
    threshold = 120,
    resetKey = null,
    initialScroll = "none",
    onScrollPosition,
    followWhen = true,
  } = options

  const scrollHostRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const shouldStickRef = useRef(initialScroll === "bottom")
  const userEngagedRef = useRef(false)
  const followWhenRef = useRef(followWhen)
  const previousResetKeyRef = useRef<string | null | undefined>(undefined)
  const hasInitializedRef = useRef(false)
  const programmaticScrollRef = useRef(false)
  const [showJumpButton, setShowJumpButton] = useState(false)

  const suspendFollowUntilRef = useRef(0)

  followWhenRef.current = followWhen

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "instant", options?: ScrollToBottomOptions) => {
    const host = scrollHostRef.current
    if (!host) return
    programmaticScrollRef.current = true
    scrollHostToBottom(host, behavior)
    if (options?.stick !== false) {
      shouldStickRef.current = true
      userEngagedRef.current = false
    } else {
      shouldStickRef.current = false
    }
    setShowJumpButton(false)
    requestAnimationFrame(() => {
      programmaticScrollRef.current = false
    })
  }, [])

  const pauseAutoScroll = useCallback(() => {
    userEngagedRef.current = true
    shouldStickRef.current = false
    setShowJumpButton(true)
  }, [])

  /** Block resize-driven follow until expiry or jumpToLatest clears it. */
  const suspendAutoFollow = useCallback((durationMs = 30_000) => {
    suspendFollowUntilRef.current = Date.now() + durationMs
    pauseAutoScroll()
  }, [pauseAutoScroll])

  const resumeAutoFollow = useCallback(() => {
    suspendFollowUntilRef.current = 0
  }, [])

  const onScroll = useCallback(() => {
    const host = scrollHostRef.current
    if (!host) return
    if (programmaticScrollRef.current) return
    const near = isNearBottom(host, threshold)
    shouldStickRef.current = near
    if (near) {
      userEngagedRef.current = false
      setShowJumpButton(false)
    } else {
      setShowJumpButton(true)
    }
    onScrollPosition?.(host.scrollTop, host)
  }, [threshold, onScrollPosition])

  const stickIfFollowing = useCallback(() => {
    const host = scrollHostRef.current
    if (!host) return
    if (Date.now() < suspendFollowUntilRef.current) return
    if (!shouldStickRef.current || userEngagedRef.current) return
    if (!followWhenRef.current) return
    programmaticScrollRef.current = true
    scrollHostToBottom(host)
    onScrollPosition?.(host.scrollTop, host)
    requestAnimationFrame(() => {
      programmaticScrollRef.current = false
    })
  }, [onScrollPosition])

  useLayoutEffect(() => {
    const host = scrollHostRef.current
    if (!host) return

    if (!hasInitializedRef.current) {
      hasInitializedRef.current = true
      previousResetKeyRef.current = resetKey
      if (initialScroll === "bottom") {
        programmaticScrollRef.current = true
        scrollHostToBottom(host)
        shouldStickRef.current = true
        requestAnimationFrame(() => {
          programmaticScrollRef.current = false
        })
      } else {
        // Do not infer stick from isNearBottom on mount — with little or no
        // content every surface looks "at bottom", then panics as runs hydrate.
        shouldStickRef.current = false
        userEngagedRef.current = false
      }
      return
    }

    const resetChanged = resetKey != null && previousResetKeyRef.current !== resetKey
    previousResetKeyRef.current = resetKey

    if (resetChanged) {
      shouldStickRef.current = true
      userEngagedRef.current = false
      programmaticScrollRef.current = true
      scrollHostToBottom(host)
      setShowJumpButton(false)
      requestAnimationFrame(() => {
        programmaticScrollRef.current = false
      })
    }
  }, [resetKey, initialScroll])

  useEffect(() => {
    const host = scrollHostRef.current
    const inner = contentRef.current
    if (!host || !inner) return

    let resizeRaf = 0
    const observer = new ResizeObserver(() => {
      if (!hasInitializedRef.current) return
      cancelAnimationFrame(resizeRaf)
      resizeRaf = requestAnimationFrame(() => {
        stickIfFollowing()
      })
    })

    observer.observe(inner)
    return () => {
      cancelAnimationFrame(resizeRaf)
      observer.disconnect()
    }
  }, [stickIfFollowing])

  return {
    scrollHostRef,
    contentRef,
    onScroll,
    scrollToBottom,
    pauseAutoScroll,
    suspendAutoFollow,
    resumeAutoFollow,
    showJumpButton,
  }
}
