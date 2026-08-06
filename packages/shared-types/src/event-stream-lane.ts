/**
 * Event Stream scan lanes — shared FE/BE contract for density + filters.
 *
 * Wire truth is EventType / EventNamespace. Lanes are the coarse scan buckets
 * used by Event Stream TYPE chroma and histogram stacks.
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

/** Derive the scan lane from a wire event type string. */
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

export function emptyLaneCounts(): Record<EventStreamLane, number> {
  return {
    run: 0,
    step: 0,
    sync: 0,
    bridge: 0,
    agent: 0,
    api: 0,
    system: 0,
  }
}
