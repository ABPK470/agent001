/**
 * Event Stream scan lanes — FE chrome + DB patterns over shared lane truth.
 */

import {
  EVENT_STREAM_LANES,
  eventStreamLane,
  type EventStreamLane,
} from "@mia/shared-types"

export { EVENT_STREAM_LANES, eventStreamLane, type EventStreamLane }

/** @deprecated Prefer EVENT_STREAM_LANES — same values, kept for prefs import sites. */
export const EVENT_TYPES = EVENT_STREAM_LANES
export type EventStreamEventType = EventStreamLane

/** SQL LIKE prefixes for deep search — must stay aligned with eventStreamLane. */
export function eventStreamLaneDbPatterns(lane: EventStreamLane): string[] {
  switch (lane) {
    case "run":
      return [
        "run.",
        "agent.started",
        "agent.completed",
        "agent.failed",
        "agent.cancelled",
        "agent.user_safe_failure",
      ]
    case "step":
      return ["step.", "tool_call.", "tool."]
    case "sync":
      return ["sync.", "sync_env."]
    case "bridge":
      return ["bridge."]
    case "agent":
      return [
        "delegation.",
        "planner.",
        "debug.",
        "agent.thinking",
        "agent.bus.",
        "agent.help.",
      ]
    case "api":
      return ["api."]
    case "system":
      return [
        "events.",
        "session.",
        "approval.",
        "memory.",
        "attachment.",
        "checkpoint.",
        "usage.",
        "stream.",
        "user_input.",
        "log.",
      ]
  }
}

/** Flatten selected lanes → type_patterns for /api/events/search. */
export function eventStreamLanesDbPatterns(
  filters: ReadonlySet<EventStreamLane> | readonly EventStreamLane[],
): string[] | undefined {
  const set = filters instanceof Set ? filters : new Set(filters)
  if (set.size === 0) return undefined
  const patterns: string[] = []
  for (const lane of set) {
    patterns.push(...eventStreamLaneDbPatterns(lane))
  }
  return patterns.length > 0 ? patterns : undefined
}

/** Log-row TYPE badge — fixed mono column + contained pill. */
export function eventStreamTypeClass(lane: EventStreamLane): string {
  return `event-stream-type event-stream-type--${lane}`
}

/**
 * Filter-sheet TYPE chip tone only — same geometry as Live / 15m chips.
 * Do not reuse eventStreamTypeClass here (min-width/mono breaks the grid).
 */
export function eventStreamFilterTypeClass(lane: EventStreamLane): string {
  return `event-stream-filter-type event-stream-filter-type--${lane}`
}
