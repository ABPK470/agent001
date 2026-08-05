import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react"
import {
  CHAT_SCROLL_INTERRUPT_AWAY_PX,
  chatScrollDistanceFromBottom,
} from "../app/chatLayout"
import {
  isNearBottom,
  scrollHostToBottom,
  scrollTopAfterHeightShrink,
} from "../lib/chatScroll"
import type { VirtualListHandle, VirtualListScrollAnchor } from "../components/VirtualList"

/**
 * Auto-scroll intent (hysteresis):
 *   following   — pin the floor on grow/shrink
 *   interrupted — inspect mode; grow never steals; shrink restores row anchor
 *
 * Interrupt: instantly when distanceFromBottom > INTERRUPT_AWAY_PX, or expand.
 * Re-engage: Jump / scrollToBottom(stick), or deliberate scroll into paper band.
 */
export type ChatScrollIntent = "following" | "interrupted"

export interface UseStickToBottomScrollOptions {
  /** Paper-band re-engage threshold (hysteresis enter). */
  threshold?: number
  resetKey?: string | null
  initialScroll?: "none" | "bottom"
  onScrollPosition?: (scrollTop: number, host: HTMLDivElement) => void
  followWhen?: boolean
  /**
   * Chat VirtualList — when interrupted, shrink restores this list's
   * index/offset anchor instead of trusting raw Δh alone.
   */
  listRef?: RefObject<VirtualListHandle | null>
}

export type ScrollToBottomOptions = {
  stick?: boolean
}

export function useStickToBottomScroll(options: UseStickToBottomScrollOptions = {}) {
  const {
    threshold = 120,
    resetKey = null,
    initialScroll = "none",
    onScrollPosition,
    followWhen = true,
    listRef,
  } = options

  const scrollHostRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const intentRef = useRef<ChatScrollIntent>(
    initialScroll === "bottom" ? "following" : "interrupted",
  )
  const followWhenRef = useRef(followWhen)
  const previousResetKeyRef = useRef<string | null | undefined>(undefined)
  const hasInitializedRef = useRef(false)
  const programmaticScrollRef = useRef(false)
  const [showJumpButton, setShowJumpButton] = useState(false)

  const lastContentHeightRef = useRef(0)
  const growFrameRef = useRef(0)
  const prevFollowWhenRef = useRef(followWhen)
  /** Last visible row while interrupted — survives async VirtualList remasure. */
  const inspectAnchorRef = useRef<VirtualListScrollAnchor | null>(null)

  followWhenRef.current = followWhen

  const setIntent = useCallback((next: ChatScrollIntent) => {
    intentRef.current = next
    setShowJumpButton(next === "interrupted")
    if (next === "following") {
      inspectAnchorRef.current = null
    }
  }, [])

  const rememberInspectAnchor = useCallback(() => {
    const anchor = listRef?.current?.captureScrollAnchor() ?? null
    if (anchor) inspectAnchorRef.current = anchor
  }, [listRef])

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "instant", options?: ScrollToBottomOptions) => {
    const host = scrollHostRef.current
    if (!host) return
    programmaticScrollRef.current = true
    scrollHostToBottom(host, behavior)
    if (options?.stick !== false) {
      intentRef.current = "following"
      inspectAnchorRef.current = null
      setShowJumpButton(false)
    } else {
      intentRef.current = "interrupted"
      setShowJumpButton(true)
    }
    requestAnimationFrame(() => {
      programmaticScrollRef.current = false
    })
  }, [])

  const pauseAutoScroll = useCallback(() => {
    rememberInspectAnchor()
    setIntent("interrupted")
  }, [rememberInspectAnchor, setIntent])

  const suspendAutoFollow = useCallback((_durationMs = 30_000) => {
    rememberInspectAnchor()
    setIntent("interrupted")
  }, [rememberInspectAnchor, setIntent])

  const resumeAutoFollow = useCallback(() => {
    intentRef.current = "following"
    inspectAnchorRef.current = null
    setShowJumpButton(false)
  }, [])

  const onScroll = useCallback(() => {
    const host = scrollHostRef.current
    if (!host) return
    if (programmaticScrollRef.current) return

    const dist = chatScrollDistanceFromBottom(host)

    // Leave following instantly on a small away-from-floor nudge (wheel/touch).
    if (dist > CHAT_SCROLL_INTERRUPT_AWAY_PX) {
      if (intentRef.current !== "interrupted") {
        rememberInspectAnchor()
        setIntent("interrupted")
      } else {
        rememberInspectAnchor()
      }
    } else if (
      intentRef.current === "interrupted"
      && dist <= threshold
    ) {
      // Deliberate return into the paper band — only path besides Jump.
      setIntent("following")
    } else if (intentRef.current === "interrupted") {
      rememberInspectAnchor()
    }

    onScrollPosition?.(host.scrollTop, host)
  }, [threshold, onScrollPosition, setIntent, rememberInspectAnchor])

  const stickIfFollowing = useCallback(() => {
    const host = scrollHostRef.current
    if (!host) return
    if (intentRef.current !== "following") return
    if (!followWhenRef.current) return
    const maxTop = Math.max(0, host.scrollHeight - host.clientHeight)
    if (Math.abs(host.scrollTop - maxTop) < 1) return
    programmaticScrollRef.current = true
    host.scrollTop = maxTop
    onScrollPosition?.(host.scrollTop, host)
    requestAnimationFrame(() => {
      programmaticScrollRef.current = false
    })
  }, [onScrollPosition])

  const scheduleGrowStick = useCallback(() => {
    if (growFrameRef.current) cancelAnimationFrame(growFrameRef.current)
    growFrameRef.current = requestAnimationFrame(() => {
      growFrameRef.current = 0
      stickIfFollowing()
    })
  }, [stickIfFollowing])

  const engageFollowIfNearBottom = useCallback(() => {
    const host = scrollHostRef.current
    if (!host || !followWhenRef.current) return
    if (intentRef.current === "interrupted") return
    if (!isNearBottom(host, threshold)) return
    intentRef.current = "following"
    setShowJumpButton(false)
    stickIfFollowing()
  }, [stickIfFollowing, threshold])

  useLayoutEffect(() => {
    const host = scrollHostRef.current
    if (!host) return

    if (!hasInitializedRef.current) {
      hasInitializedRef.current = true
      previousResetKeyRef.current = resetKey
      if (initialScroll === "bottom") {
        programmaticScrollRef.current = true
        scrollHostToBottom(host)
        intentRef.current = "following"
        requestAnimationFrame(() => {
          programmaticScrollRef.current = false
        })
      } else {
        intentRef.current = "interrupted"
      }
      return
    }

    const resetChanged = resetKey != null && previousResetKeyRef.current !== resetKey
    previousResetKeyRef.current = resetKey

    if (resetChanged) {
      intentRef.current = "following"
      inspectAnchorRef.current = null
      lastContentHeightRef.current = 0
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

    const observer = new ResizeObserver(() => {
      if (!hasInitializedRef.current) return
      const height = inner.scrollHeight
      const prevHeight = lastContentHeightRef.current

      if (height < prevHeight) {
        const delta = prevHeight - height
        lastContentHeightRef.current = height
        if (delta <= 0) return

        if (intentRef.current === "following" && followWhenRef.current) {
          stickIfFollowing()
          return
        }

        // Interrupted: prefer VirtualList index/offset lock; Δh is fallback.
        programmaticScrollRef.current = true
        const anchor = inspectAnchorRef.current
        if (anchor && listRef?.current) {
          listRef.current.restoreScrollAnchor(anchor)
        } else {
          host.scrollTop = scrollTopAfterHeightShrink(host.scrollTop, delta)
          const maxTop = Math.max(0, host.scrollHeight - host.clientHeight)
          if (host.scrollTop > maxTop) host.scrollTop = maxTop
        }
        requestAnimationFrame(() => {
          // Remasure can settle one frame later — restore again if we still
          // have an inspect lock.
          if (intentRef.current === "interrupted" && inspectAnchorRef.current && listRef?.current) {
            listRef.current.restoreScrollAnchor(inspectAnchorRef.current)
          }
          programmaticScrollRef.current = false
        })
        return
      }

      if (height === prevHeight) return
      lastContentHeightRef.current = height
      scheduleGrowStick()
    })

    observer.observe(inner)
    return () => {
      if (growFrameRef.current) cancelAnimationFrame(growFrameRef.current)
      observer.disconnect()
    }
  }, [scheduleGrowStick, stickIfFollowing, listRef])

  useEffect(() => {
    const wasLive = prevFollowWhenRef.current
    prevFollowWhenRef.current = followWhen
    if (!followWhen || wasLive) return
    const host = scrollHostRef.current
    if (!host || intentRef.current === "interrupted") return
    if (isNearBottom(host, threshold)) {
      intentRef.current = "following"
      setShowJumpButton(false)
      stickIfFollowing()
    }
  }, [followWhen, stickIfFollowing, threshold])

  return {
    scrollHostRef,
    contentRef,
    onScroll,
    scrollToBottom,
    pauseAutoScroll,
    suspendAutoFollow,
    resumeAutoFollow,
    engageFollowIfNearBottom,
    showJumpButton,
    stickIfFollowing,
  }
}
