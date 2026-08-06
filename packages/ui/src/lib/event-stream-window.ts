/**
 * Pure Event Stream window / merge helpers (no transport).
 */

import type { EventStreamRange, EventStreamWindow } from "./event-stream-prefs"
import type { LogEntry } from "../types"

export const EVENT_STREAM_EXCLUDE_TYPES = ["debug.trace"] as const
export const EVENT_STREAM_PAGE_SIZE = 500
export const EVENT_STREAM_MAX_BUFFER = 5000
export const EVENT_STREAM_LIVE_LOOKBACK_MS = 60 * 60 * 1000

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

export function startOfLocalDay(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number)
  return new Date(y!, m! - 1, d!, 0, 0, 0, 0).toISOString()
}

export function endOfLocalDay(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number)
  return new Date(y!, m! - 1, d!, 23, 59, 59, 999).toISOString()
}

export function resolveWindowBounds(window: EventStreamWindow): {
  since: string
  until?: string
  followLive: boolean
} {
  // Fine brush / zoom — ISO takes precedence over day picks + quick ranges.
  if (window.sinceIso) {
    return {
      since: window.sinceIso,
      until: window.untilIso,
      followLive: false,
    }
  }
  const hasCustom = Boolean(window.from || window.to)
  if (hasCustom) {
    if (window.from && window.to) {
      return {
        since: startOfLocalDay(window.from),
        until: endOfLocalDay(window.to),
        followLive: false,
      }
    }
    if (window.from) {
      return { since: startOfLocalDay(window.from), followLive: false }
    }
    return {
      since: startOfLocalDay(window.to!),
      until: endOfLocalDay(window.to!),
      followLive: false,
    }
  }
  return {
    since: sinceForRange(window.range),
    followLive: window.range === "live",
  }
}

export function logInWindow(
  timestamp: string,
  bounds: { since: string; until?: string },
): boolean {
  if (timestamp < bounds.since) return false
  if (bounds.until && timestamp > bounds.until) return false
  return true
}

function logDedupeKey(log: LogEntry): string {
  return `${log.timestamp}|${log.eventName ?? ""}|${log.message}`
}

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
