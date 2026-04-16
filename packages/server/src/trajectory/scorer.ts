import { loadTrajectory } from "./loader.js"
import type { ToolCallEvent, Trajectory } from "./types.js"

// ── Scorecard ────────────────────────────────────────────────────

export interface Scorecard {
  /** Total number of events in the trajectory. */
  totalEvents: number
  /** Number of tool calls made. */
  toolCalls: number
  /** Number of tool errors encountered. */
  toolErrors: number
  /** Tool error rate (0–1). */
  errorRate: number
  /** Number of iterations (LLM calls). */
  iterations: number
  /** Number of delegation events. */
  delegations: number
  /** Did the run produce a final answer? */
  hasAnswer: boolean
  /** Did the run end in an error? */
  hasError: boolean
  /** Tools used (unique, in order of first use). */
  toolsUsed: string[]
  /** Tool call frequency map. */
  toolFrequency: Record<string, number>
  /** Average events per iteration (efficiency metric). */
  eventsPerIteration: number
  /** Thinking/tool-call ratio — higher = more deliberation. */
  thinkToActRatio: number
  /**
   * Trajectory patterns detected:
   *   - "retry-loop"    → same tool called 3+ times in a row
   *   - "broad-search"  → 3+ different tools used without thinking between
   *   - "efficient"     → < 3 events per iteration avg
   *   - "delegation"    → uses delegation
   *   - "single-shot"   → 1 iteration only
   */
  patterns: string[]
}

export function generateScorecard(trajectory: Trajectory): Scorecard {
  const events = trajectory.events.map((e) => e.event)
  const toolCalls = events.filter((e) => e.kind === "tool-call") as ToolCallEvent[]
  const toolErrors = events.filter((e) => e.kind === "tool-error")
  const iterations = events.filter((e) => e.kind === "iteration")
  const thinkingEvents = events.filter((e) => e.kind === "thinking")
  const delegations = events.filter((e) => e.kind === "delegation-start")

  const hasAnswer = events.some((e) => e.kind === "answer")
  const hasError = events.some((e) => e.kind === "error")

  // Tool usage stats
  const toolsUsed: string[] = []
  const toolFrequency: Record<string, number> = {}
  for (const tc of toolCalls) {
    if (!toolsUsed.includes(tc.tool)) toolsUsed.push(tc.tool)
    toolFrequency[tc.tool] = (toolFrequency[tc.tool] ?? 0) + 1
  }

  const iterCount = Math.max(1, iterations.length)
  const eventsPerIteration = events.length / iterCount

  const thinkToActRatio =
    toolCalls.length > 0
      ? thinkingEvents.length / toolCalls.length
      : thinkingEvents.length > 0
        ? Infinity
        : 0

  // Pattern detection
  const patterns: string[] = []

  // Retry loop: same tool 3+ times consecutively
  let consecutive = 1
  for (let i = 1; i < toolCalls.length; i++) {
    if (toolCalls[i].tool === toolCalls[i - 1].tool) {
      consecutive++
      if (consecutive >= 3) {
        patterns.push("retry-loop")
        break
      }
    } else {
      consecutive = 1
    }
  }

  // Broad search: 3+ different tools without thinking in between
  let uniqueToolsWithoutThink = new Set<string>()
  for (let i = 0; i < events.length; i++) {
    if (events[i].kind === "tool-call") {
      uniqueToolsWithoutThink.add((events[i] as ToolCallEvent).tool)
      if (uniqueToolsWithoutThink.size >= 3) {
        patterns.push("broad-search")
        break
      }
    } else if (events[i].kind === "thinking") {
      uniqueToolsWithoutThink = new Set()
    }
  }

  if (eventsPerIteration < 3) patterns.push("efficient")
  if (delegations.length > 0) patterns.push("delegation")
  if (iterations.length <= 1) patterns.push("single-shot")

  return {
    totalEvents: events.length,
    toolCalls: toolCalls.length,
    toolErrors: toolErrors.length,
    errorRate: toolCalls.length > 0 ? toolErrors.length / toolCalls.length : 0,
    iterations: iterations.length,
    delegations: delegations.length,
    hasAnswer,
    hasError,
    toolsUsed,
    toolFrequency,
    eventsPerIteration,
    thinkToActRatio,
    patterns,
  }
}

// ── Utility: trajectory summary for debugging ────────────────────

/** Produce a compact human-readable summary of a trajectory. */
export function summarizeTrajectory(runId: string): string {
  const t = loadTrajectory(runId)
  if (t.events.length === 0) return "(empty trajectory)"

  const lines: string[] = [`Trajectory for run ${runId} (${t.events.length} events):`]

  for (const { seq, event, timestamp } of t.events) {
    const time = timestamp.split("T")[1]?.split(".")[0] ?? ""
    switch (event.kind) {
      case "goal":
        lines.push(`  [${seq}] ${time} GOAL: ${event.text.slice(0, 80)}`)
        break
      case "thinking":
        lines.push(`  [${seq}] ${time} THINK: ${event.text.slice(0, 60)}…`)
        break
      case "tool-call":
        lines.push(`  [${seq}] ${time} CALL: ${event.tool}(${event.argsSummary})`)
        break
      case "tool-result":
        lines.push(`  [${seq}] ${time} RESULT: ${event.text.slice(0, 60)}…`)
        break
      case "tool-error":
        lines.push(`  [${seq}] ${time} ERROR: ${event.text.slice(0, 60)}…`)
        break
      case "iteration":
        lines.push(`  [${seq}] ${time} ITER: ${event.current}/${event.max}`)
        break
      case "delegation-start":
        lines.push(`  [${seq}] ${time} DELEGATE: ${event.childGoal.slice(0, 60)}`)
        break
      case "delegation-end":
        lines.push(`  [${seq}] ${time} DELEGATE-DONE: ${event.result.slice(0, 60)}`)
        break
      case "answer":
        lines.push(`  [${seq}] ${time} ANSWER: ${event.text.slice(0, 80)}`)
        break
      case "error":
        lines.push(`  [${seq}] ${time} FATAL: ${event.text.slice(0, 80)}`)
        break
    }
  }

  return lines.join("\n")
}
