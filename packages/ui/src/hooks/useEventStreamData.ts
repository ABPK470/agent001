/**
 * Event Stream data layer — Datadog Live Tail / Log Explorer model:
 *
 * - Quick range (Live / 15m / 1h / 6h / 24h) or custom From/Until dates
 * - Live mode also appends SSE rows from the global store as they arrive
 * - Scroll-up loads older pages via `before` cursor within the same window
 * - High-volume debug.trace is excluded at the API
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { api } from "../client/index"
import { formatLogEntry, useStore } from "../state/store"
import type { LogEntry } from "../types"

/** Wire types omitted from the stream (owned by Trace / Pipelines). */
export const EVENT_STREAM_EXCLUDE_TYPES = ["debug.trace"] as const

/** First page size — enough for a busy minute without drowning the UI. */
export const EVENT_STREAM_PAGE_SIZE = 500

/** Hard cap on rows held in the widget (oldest dropped). */
export const EVENT_STREAM_MAX_BUFFER = 5000

/**
 * Live Tail default lookback: open → last hour of history, then follow.
 */
export const EVENT_STREAM_LIVE_LOOKBACK_MS = 60 * 60 * 1000

export type EventStreamRange = "live" | "15m" | "1h" | "6h" | "24h"

const RANGE_MS: Record<Exclude<EventStreamRange, "live">, number> = {
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
}

export function sinceForRange(range: EventStreamRange, now = Date.now()): string {
  const ms = range === "live" ? EVENT_STREAM_LIVE_LOOKBACK_MS : RANGE_MS[range]
  return new Date(now - ms).toISOString()
}

/** Local calendar day → ISO bounds (matches DateField / Sync History). */
export function startOfLocalDay(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number)
  return new Date(y!, m! - 1, d!, 0, 0, 0, 0).toISOString()
}

export function endOfLocalDay(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number)
  return new Date(y!, m! - 1, d!, 23, 59, 59, 999).toISOString()
}

export type EventStreamWindow = {
  range: EventStreamRange
  /** YYYY-MM-DD from DateField */
  from?: string
  /** YYYY-MM-DD from DateField */
  to?: string
}

export function resolveWindowBounds(window: EventStreamWindow): {
  since: string
  until?: string
  followLive: boolean
} {
  const hasCustom = Boolean(window.from || window.to)
  if (hasCustom) {
    return {
      since: window.from ? startOfLocalDay(window.from) : sinceForRange(window.range),
      until: window.to ? endOfLocalDay(window.to) : undefined,
      followLive: false,
    }
  }
  return {
    since: sinceForRange(window.range),
    followLive: window.range === "live",
  }
}

function logDedupeKey(log: LogEntry): string {
  return `${log.timestamp}|${log.eventName ?? ""}|${log.message}`
}

function mapRawEvents(
  events: Array<{ type: string; data: Record<string, unknown>; timestamp: string }>,
): LogEntry[] {
  const out: LogEntry[] = []
  for (const ev of events) {
    const entry = formatLogEntry(ev.type, ev.data ?? {}, ev.timestamp)
    if (entry) out.push(entry)
  }
  return out
}

/** Merge pages / live tips; keep chronological ASC; cap buffer. */
export function mergeLogEntries(...groups: LogEntry[][]): LogEntry[] {
  const byKey = new Map<string, LogEntry>()
  for (const group of groups) {
    for (const log of group) {
      byKey.set(logDedupeKey(log), log)
    }
  }
  return [...byKey.values()]
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    .slice(-EVENT_STREAM_MAX_BUFFER)
}

export interface UseEventStreamDataResult {
  entries: LogEntry[]
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
  followLive: boolean
}

export function useEventStreamData(opts: {
  paused: boolean
}): UseEventStreamDataResult {
  const { paused } = opts
  const [window, setWindow] = useState<EventStreamWindow>({ range: "live" })
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [oldestCursor, setOldestCursor] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pendingLiveCount, setPendingLiveCount] = useState(0)

  const bounds = resolveWindowBounds(window)
  const sinceRef = useRef(bounds.since)
  const untilRef = useRef<string | undefined>(bounds.until)
  const followLiveRef = useRef(bounds.followLive)
  const generation = useRef(0)
  const liveWatermarkRef = useRef<string>("")
  const pendingAckRef = useRef<string>("")
  const storeLogs = useStore((s) => s.logs)

  sinceRef.current = bounds.since
  untilRef.current = bounds.until
  followLiveRef.current = bounds.followLive

  const fetchPage = useCallback(async (args: {
    since: string
    until?: string
    before?: string
    replace: boolean
  }) => {
    return api.listEvents({
      limit: EVENT_STREAM_PAGE_SIZE,
      since: args.since,
      until: args.until,
      before: args.before,
      exclude_types: [...EVENT_STREAM_EXCLUDE_TYPES],
    }).then((res) => {
      const mapped = mapRawEvents(res.events)
      if (args.replace) {
        setEntries(mergeLogEntries(mapped))
        setOldestCursor(res.oldestTimestamp)
        setHasMore(res.hasMore)
        if (res.newestTimestamp) liveWatermarkRef.current = res.newestTimestamp
      } else {
        setEntries((prev) => mergeLogEntries(mapped, prev))
        setOldestCursor(res.oldestTimestamp)
        setHasMore(res.hasMore)
      }
      return res
    })
  }, [])

  const reload = useCallback((next: EventStreamWindow) => {
    const gen = ++generation.current
    const nextBounds = resolveWindowBounds(next)
    sinceRef.current = nextBounds.since
    untilRef.current = nextBounds.until
    followLiveRef.current = nextBounds.followLive
    setLoading(true)
    setError(null)
    setPendingLiveCount(0)
    pendingAckRef.current = ""
    setHasMore(false)
    setOldestCursor(null)
    void fetchPage({
      since: nextBounds.since,
      until: nextBounds.until,
      replace: true,
    })
      .catch((err: unknown) => {
        if (gen !== generation.current) return
        setEntries([])
        setError(err instanceof Error ? err.message : "Failed to load events")
      })
      .finally(() => {
        if (gen === generation.current) setLoading(false)
      })
  }, [fetchPage])

  useEffect(() => {
    reload(window)
  }, [window, reload])

  const setQuickRange = useCallback((range: EventStreamRange) => {
    setWindow({ range, from: undefined, to: undefined })
  }, [])

  const setFromDate = useCallback((from: string | undefined) => {
    setWindow((prev) => ({ ...prev, from: from || undefined }))
  }, [])

  const setToDate = useCallback((to: string | undefined) => {
    setWindow((prev) => ({ ...prev, to: to || undefined }))
  }, [])

  const clearCustomDates = useCallback(() => {
    setWindow((prev) => ({ range: prev.range, from: undefined, to: undefined }))
  }, [])

  const jumpToLive = useCallback(() => {
    setPendingLiveCount(0)
    setWindow({ range: "live" })
  }, [])

  const loadOlder = useCallback(() => {
    if (loadingOlder || !hasMore || !oldestCursor) return
    const gen = generation.current
    setLoadingOlder(true)
    void fetchPage({
      since: sinceRef.current,
      until: untilRef.current,
      before: oldestCursor,
      replace: false,
    })
      .catch((err: unknown) => { console.error("[mia]", err) })
      .finally(() => {
        if (gen === generation.current) setLoadingOlder(false)
      })
  }, [fetchPage, hasMore, loadingOlder, oldestCursor])

  useEffect(() => {
    if (storeLogs.length === 0) return
    const watermark = liveWatermarkRef.current
    const until = untilRef.current
    const fresh = storeLogs.filter((l) => {
      if (l.eventName === "debug.trace") return false
      if (!l.timestamp) return false
      if (watermark && l.timestamp <= watermark) return false
      if (l.timestamp < sinceRef.current) return false
      if (until && l.timestamp > until) return false
      return true
    })
    if (fresh.length === 0) return

    const followLive = followLiveRef.current && !paused
    if (!followLive) {
      const unacked = fresh.filter(
        (l) => !pendingAckRef.current || l.timestamp > pendingAckRef.current,
      )
      if (unacked.length === 0) return
      pendingAckRef.current = unacked[unacked.length - 1]!.timestamp
      setPendingLiveCount((n) => n + unacked.length)
      return
    }

    setEntries((prev) => {
      const merged = mergeLogEntries(prev, fresh)
      const newest = merged[merged.length - 1]?.timestamp
      if (newest) {
        liveWatermarkRef.current = newest
        pendingAckRef.current = newest
      }
      return merged
    })
    setPendingLiveCount(0)
  }, [storeLogs, paused, window])

  return {
    entries,
    loading,
    loadingOlder,
    hasMore,
    loadOlder,
    error,
    pendingLiveCount,
    jumpToLive,
    window,
    setQuickRange,
    setFromDate,
    setToDate,
    clearCustomDates,
    followLive: bounds.followLive,
  }
}
