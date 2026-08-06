/**
 * Event Stream lens — retains the shared capability owner.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { useTilePaint } from "../app/workspace/tile-paint"
import {
  type EventStreamRange,
  type EventStreamWindow,
} from "../lib/event-stream-prefs"
import { useEventStreamStore } from "../state/event-stream-store"
import { useViewingAs } from "./useViewingAs"

export type { EventStreamRange, EventStreamWindow }

export {
  EVENT_STREAM_EXCLUDE_TYPES,
  EVENT_STREAM_LIVE_LOOKBACK_MS,
  EVENT_STREAM_MAX_BUFFER,
  EVENT_STREAM_PAGE_SIZE,
  endOfLocalDay,
  logInWindow,
  mergeLogEntries,
  resolveWindowBounds,
  sinceForRange,
  startOfLocalDay,
} from "../lib/event-stream-window"

export interface UseEventStreamDataResult {
  entries: ReturnType<typeof useEventStreamStore.getState>["entries"]
  loading: boolean
  loadingOlder: boolean
  hasMore: boolean
  loadOlder: () => void
  error: string | null
  pendingLiveCount: number
  jumpToLive: () => void
  window: EventStreamWindow
  setQuickRange: (range: EventStreamRange) => void
  setFromDate: (from: string | undefined) => void
  setToDate: (to: string | undefined) => void
  clearCustomDates: () => void
  /** Zoom the store window to an ISO brush range (re-fetch). */
  zoomToIsoRange: (sinceIso: string, untilIso: string) => void
  followLive: boolean
}

export function useEventStreamData(opts: {
  paused: boolean
  initialWindow?: EventStreamWindow
}): UseEventStreamDataResult {
  const { paused, initialWindow } = opts
  const { viewingAsUpn } = useViewingAs()
  const { soloHidden } = useTilePaint()
  const [localWindow, setLocalWindow] = useState<EventStreamWindow>(
    () => initialWindow ?? { range: "live" },
  )

  const retain = useEventStreamStore((s) => s.retain)
  const release = useEventStreamStore((s) => s.release)
  const setWindow = useEventStreamStore((s) => s.setWindow)
  const setPaused = useEventStreamStore((s) => s.setPaused)
  const setViewingAs = useEventStreamStore((s) => s.setViewingAs)
  const loadOlder = useEventStreamStore((s) => s.loadOlder)
  const jumpToLiveStore = useEventStreamStore((s) => s.jumpToLive)
  const setPaintSuspended = useEventStreamStore((s) => s.setPaintSuspended)

  const entries = useEventStreamStore((s) => s.entries)
  const loading = useEventStreamStore((s) => s.loading)
  const loadingOlder = useEventStreamStore((s) => s.loadingOlder)
  const hasMore = useEventStreamStore((s) => s.hasMore)
  const error = useEventStreamStore((s) => s.error)
  const pendingLiveCount = useEventStreamStore((s) => s.pendingLiveCount)
  const followLive = useEventStreamStore((s) => s.followLive)
  const paintSuspended = useEventStreamStore((s) => s.paintSuspended)

  const frozenRef = useRef(entries)
  if (!paintSuspended && !soloHidden) frozenRef.current = entries

  useEffect(() => {
    setPaintSuspended(soloHidden)
  }, [soloHidden, setPaintSuspended])

  useEffect(() => {
    retain({ window: localWindow, viewingAsUpn, paused })
    return () => release()
  }, [retain, release])

  useEffect(() => {
    setWindow(localWindow)
  }, [localWindow, setWindow])

  useEffect(() => {
    setPaused(paused)
  }, [paused, setPaused])

  useEffect(() => {
    setViewingAs(viewingAsUpn)
  }, [viewingAsUpn, setViewingAs])

  const setQuickRange = useCallback((range: EventStreamRange) => {
    setLocalWindow({ range })
  }, [])

  const setFromDate = useCallback((from: string | undefined) => {
    setLocalWindow((prev) => ({
      ...prev,
      from: from || undefined,
      sinceIso: undefined,
      untilIso: undefined,
    }))
  }, [])

  const setToDate = useCallback((to: string | undefined) => {
    setLocalWindow((prev) => ({
      ...prev,
      to: to || undefined,
      sinceIso: undefined,
      untilIso: undefined,
    }))
  }, [])

  const clearCustomDates = useCallback(() => {
    setLocalWindow((prev) => ({ range: prev.range }))
  }, [])

  const zoomToIsoRange = useCallback((sinceIso: string, untilIso: string) => {
    setLocalWindow({
      range: "live",
      sinceIso,
      untilIso,
    })
  }, [])

  const jumpToLive = useCallback(() => {
    setLocalWindow({ range: "live" })
    jumpToLiveStore()
  }, [jumpToLiveStore])

  return {
    entries: paintSuspended || soloHidden ? frozenRef.current : entries,
    loading,
    loadingOlder,
    hasMore,
    loadOlder,
    error,
    pendingLiveCount,
    jumpToLive,
    window: localWindow,
    setQuickRange,
    setFromDate,
    setToDate,
    clearCustomDates,
    zoomToIsoRange,
    followLive,
  }
}
