/**
 * Event Stream scan lanes — seven coarse buckets for filter + TYPE chroma.
 *
 * Wire truth is EventType / EventNamespace (shared-enums). This module is the
 * single FE source for how those map into scan lanes. Keep labels stable
 * (`agent` = orchestration, matching Op Log language) even when BE namespaces
 * differ (EventNamespace.Agent lifecycle is legacy; cognition is planner/delegation).
 *
 *   run    — job envelope (run.* + legacy agent.started/completed/…)
 *   step   — atomic tool work (step.*, tool_call.*, tool.*)
 *   agent  — cognition / orchestration (planner.*, delegation.*, thinking, …)
 *   sync   — sync data plane (sync.*, sync_env.*)
 *   bridge — connector→connector
 *   api    — HTTP telemetry
 *   system — residual platform
 */

export const EVENT_STREAM_LANES = [
  "run",
  "step",
  "sync",
  "bridge",
  "agent",
  "api",
  "system",
] as const

export type EventStreamLane = (typeof EVENT_STREAM_LANES)[number]

/** @deprecated Prefer EVENT_STREAM_LANES — same values, kept for prefs import sites. */
export const EVENT_TYPES = EVENT_STREAM_LANES
export type EventStreamEventType = EventStreamLane

const LEGACY_AGENT_LIFECYCLE = new Set([
  "agent.started",
  "agent.completed",
  "agent.failed",
  "agent.cancelled",
  "agent.user_safe_failure",
])

const AGENT_COGNITION = new Set([
  "agent.thinking",
  "agent.bus.message",
  "agent.help.requested",
  "answer.chunk",
  "debug.trace",
])

/**
 * Derive the scan lane from a wire event type string.
 * Behavioral contract — tests lock step ≠ agent, sync_env → sync, tool.* → step.
 */
export function eventStreamLane(wireType: string): EventStreamLane {
  if (wireType.startsWith("sync.") || wireType.startsWith("sync_env.")) return "sync"
  if (wireType.startsWith("bridge.")) return "bridge"
  if (wireType.startsWith("run.")) return "run"
  if (
    wireType.startsWith("step.")
    || wireType.startsWith("tool_call.")
    || wireType.startsWith("tool.")
  ) {
    return "step"
  }
  if (wireType.startsWith("delegation.") || wireType.startsWith("planner.")) return "agent"
  if (LEGACY_AGENT_LIFECYCLE.has(wireType)) return "run"
  if (AGENT_COGNITION.has(wireType)) return "agent"
  if (wireType.startsWith("api.")) return "api"
  return "system"
}

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

/** CSS modifier suffix — `event-stream-type--${lane}`. */
export function eventStreamTypeClass(lane: EventStreamLane): string {
  return `event-stream-type event-stream-type--${lane}`
}
