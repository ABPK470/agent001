/**
 * Pipelines time window — same quick ranges / From–Until as Event Stream.
 * `live` stays unbounded (full durable history + SSE); quick ranges bind `since`.
 */

import type { EventStreamRange, EventStreamWindow } from "./event-stream-prefs"
import { endOfLocalDay, sinceForRange, startOfLocalDay } from "./event-stream-window"

export type OperationsTimeRange = EventStreamRange
export type OperationsTimeWindow = EventStreamWindow

export function resolveOperationsWindowBounds(window: OperationsTimeWindow): {
  since?: string
  until?: string
  followLive: boolean
} {
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
  if (window.range === "live") {
    // Full tip + follow — date filters are how you narrow history (not a 1h amnesia).
    return { followLive: true }
  }
  return {
    since: sinceForRange(window.range),
    followLive: false,
  }
}
