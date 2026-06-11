import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { isNearBottom, scrollHostToBottom } from "../lib/chatScroll"

export interface UseStickToBottomScrollOptions {
  /** Pixels from bottom to still count as "following" live output. */
  threshold?: number
  /** When these change, scroll to bottom if stuck and user is not engaged. */
  scrollTriggers?: unknown[]
  /** When this changes (e.g. active run id), force one stick-to-bottom. */
  resetKey?: string | null
  /** Optional hook for top fade masks etc. */
  onScrollPosition?: (scrollTop: number, host: HTMLDivElement) => void
}

export function useStickToBottomScroll(options: UseStickToBottomScrollOptions = {}) {
  const {
    threshold = 120,
    scrollTriggers = [],
    resetKey = null,
    onScrollPosition,
  } = options

  const scrollHostRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const shouldStickRef = useRef(true)
  const userEngagedRef = useRef(false)
  const previousResetKeyRef = useRef<string | null | undefined>(undefined)
  const [showJumpButton, setShowJumpButton] = useState(false)

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "instant") => {
    const host = scrollHostRef.current
    if (!host) return
    scrollHostToBottom(host, behavior)
    shouldStickRef.current = true
    userEngagedRef.current = false
    setShowJumpButton(false)
  }, [])

  const pauseAutoScroll = useCallback(() => {
    userEngagedRef.current = true
    shouldStickRef.current = false
    setShowJumpButton(true)
  }, [])

  const onScroll = useCallback(() => {
    const host = scrollHostRef.current
    if (!host) return
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

  useLayoutEffect(() => {
    const host = scrollHostRef.current
    if (!host) return

    const resetChanged = previousResetKeyRef.current !== resetKey
    previousResetKeyRef.current = resetKey

    if (resetChanged) {
      shouldStickRef.current = true
      userEngagedRef.current = false
      scrollHostToBottom(host)
      setShowJumpButton(false)
      return
    }

    if (shouldStickRef.current && !userEngagedRef.current) {
      scrollHostToBottom(host)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scrollTriggers are the intentional deps
  }, [resetKey, ...scrollTriggers])

  useEffect(() => {
    const host = scrollHostRef.current
    const inner = contentRef.current
    if (!host || !inner) return

    const observer = new ResizeObserver(() => {
      if (!shouldStickRef.current || userEngagedRef.current) return
      scrollHostToBottom(host)
      onScrollPosition?.(host.scrollTop, host)
    })

    observer.observe(inner)
    return () => observer.disconnect()
  }, [onScrollPosition])

  return {
    scrollHostRef,
    contentRef,
    onScroll,
    scrollToBottom,
    pauseAutoScroll,
    showJumpButton,
  }
}
