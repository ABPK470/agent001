/**
 * Event Stream data layer — Datadog Live Tail / Log Explorer model:
 *
 * - Time range (Live / 15m / 1h / 6h / 24h) loads surface events from event_log
 * - Live mode also appends SSE rows from the global store as they arrive
 * - Scroll-up loads older pages via `before` cursor within the same `since` window
 * - High-volume debug.trace is excluded at the API (not a separate "DB" pane)
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
 * Live Tail default lookback (Datadog-style): open → last hour of history,
 * then follow new events. Longer history = pick an explicit range.
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
  /** Live events arrived while paused or while viewing a fixed range. */
  pendingLiveCount: number
  jumpToLive: () => void
  range: EventStreamRange
  setRange: (range: EventStreamRange) => void
}

export function useEventStreamData(opts: {
  paused: boolean
}): UseEventStreamDataResult {
  const { paused } = opts
  const [range, setRangeState] = useState<EventStreamRange>("live")
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [oldestCursor, setOldestCursor] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pendingLiveCount, setPendingLiveCount] = useState(0)

  const sinceRef = useRef<string>(sinceForRange("live"))
  const generation = useRef(0)
  /** Newest timestamp already merged into `entries`. */
  const liveWatermarkRef = useRef<string>("")
  /** Newest timestamp already counted toward pendingLiveCount while paused / not Live. */
  const pendingAckRef = useRef<string>("")
  const storeLogs = useStore((s) => s.logs)

  const fetchPage = useCallback(async (args: {
    since: string
    before?: string
    replace: boolean
  }) => {
    return api.listEvents({
      limit: EVENT_STREAM_PAGE_SIZE,
      since: args.since,
      before: args.before,
      exclude_types: [...EVENT_STREAM_EXCLUDE_TYPES],
    }).then((res) => {
      const mapped = mapRawEvents(res.events)
      // API returns newest-first; mergeLogEntries sorts ASC.
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

  const reloadRange = useCallback((next: EventStreamRange) => {
    const gen = ++generation.current
    const since = sinceForRange(next)
    sinceRef.current = since
    setLoading(true)
    setError(null)
    setPendingLiveCount(0)
    pendingAckRef.current = ""
    setHasMore(false)
    setOldestCursor(null)
    void fetchPage({ since, replace: true })
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
    reloadRange(range)
  }, [range, reloadRange])

  const setRange = useCallback((next: EventStreamRange) => {
    setRangeState(next)
  }, [])

  const jumpToLive = useCallback(() => {
    setPendingLiveCount(0)
    if (range !== "live") {
      setRangeState("live")
      return
    }
    reloadRange("live")
  }, [range, reloadRange])

  const loadOlder = useCallback(() => {
    if (loadingOlder || !hasMore || !oldestCursor) return
    const gen = generation.current
    setLoadingOlder(true)
    void fetchPage({ since: sinceRef.current, before: oldestCursor, replace: false })
      .catch(() => { /* keep current page */ })
      .finally(() => {
        if (gen === generation.current) setLoadingOlder(false)
      })
  }, [fetchPage, hasMore, loadingOlder, oldestCursor])

  // Live tip: fold store SSE rows into the stream (Live + not paused).
  useEffect(() => {
    if (storeLogs.length === 0) return
    const watermark = liveWatermarkRef.current
    const fresh = storeLogs.filter((l) => {
      if (l.eventName === "debug.trace") return false
      if (!l.timestamp) return false
      if (watermark && l.timestamp <= watermark) return false
      if (l.timestamp < sinceRef.current) return false
      return true
    })
    if (fresh.length === 0) return

    const followLive = range === "live" && !paused
    if (!followLive) {
      const unacked = fresh.filter(
        (l) => !pendingAckRef.current || l.timestamp > pendingAckRef.current,
      )
      if (unacked.length === 0) return
      const newest = unacked[unacked.length - 1]!.timestamp
      pendingAckRef.current = newest
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
  }, [storeLogs, range, paused])

  return {
    entries,
    loading,
    loadingOlder,
    hasMore,
    loadOlder,
    error,
    pendingLiveCount,
    jumpToLive,
    range,
    setRange,
  }
}
