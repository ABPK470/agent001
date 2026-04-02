/**
 * Trajectory Recording & Replay Engine.
 *
 * Records the full decision trajectory of an agent run as a sequence of
 * typed events, then allows:
 *   - Replay with validation — re-run the trace and verify state transitions
 *   - Mutation injection — drop a completion, flip a verdict, inject an error
 *   - Scorecard generation — summarize quality metrics from a trace
 *
 * Built on top of the existing trace_entries table (run_id, seq, data).
 * This module adds typed structure and replay semantics on top.
 */

import { getDb } from "./db.js"

// ── Event types (what we record) ─────────────────────────────────

/** Discriminated union of all trajectory events. */
export type TrajectoryEvent =
  | GoalEvent
  | ThinkingEvent
  | ToolCallEvent
  | ToolResultEvent
  | ToolErrorEvent
  | IterationEvent
  | DelegationStartEvent
  | DelegationEndEvent
  | AnswerEvent
  | ErrorEvent

interface GoalEvent {
  kind: "goal"
  text: string
}

interface ThinkingEvent {
  kind: "thinking"
  text: string
}

interface ToolCallEvent {
  kind: "tool-call"
  tool: string
  argsSummary: string
  argsFormatted: string
}

interface ToolResultEvent {
  kind: "tool-result"
  text: string
}

interface ToolErrorEvent {
  kind: "tool-error"
  text: string
}

interface IterationEvent {
  kind: "iteration"
  current: number
  max: number
}

interface DelegationStartEvent {
  kind: "delegation-start"
  childGoal: string
  childRunId: string
}

interface DelegationEndEvent {
  kind: "delegation-end"
  childRunId: string
  result: string
}

interface AnswerEvent {
  kind: "answer"
  text: string
}

interface ErrorEvent {
  kind: "error"
  text: string
}

// ── Trajectory (typed wrapper around trace_entries) ──────────────

export interface Trajectory {
  runId: string
  events: Array<{ seq: number; event: TrajectoryEvent; timestamp: string }>
}

/** Load the full trajectory for a run. */
export function loadTrajectory(runId: string): Trajectory {
  const rows = getDb()
    .prepare("SELECT seq, data, created_at FROM trace_entries WHERE run_id = ? ORDER BY seq")
    .all(runId) as Array<{ seq: number; data: string; created_at: string }>

  const events = rows
    .map((row) => {
      try {
        const event = JSON.parse(row.data) as TrajectoryEvent
        return { seq: row.seq, event, timestamp: row.created_at }
      } catch {
        return null
      }
    })
    .filter((e): e is NonNullable<typeof e> => e !== null)

  return { runId, events }
}

// ── Replay engine ────────────────────────────────────────────────

/**
 * Mutation: alter the trajectory before replay to test resilience.
 *
 *   - drop(seq)        — remove an event at sequence number
 *   - replace(seq, ev) — swap an event for a different one
 *   - inject(seq, ev)  — insert a new event before the given seq
 */
export type Mutation =
  | { type: "drop"; seq: number }
  | { type: "replace"; seq: number; event: TrajectoryEvent }
  | { type: "inject"; seq: number; event: TrajectoryEvent }

/** Apply mutations to a trajectory (returns a new trajectory, no side effects). */
export function applyMutations(
  trajectory: Trajectory,
  mutations: Mutation[],
): Trajectory {
  let events = [...trajectory.events]

  // Sort mutations by seq descending so inserts/drops don't shift later indices
  const sorted = [...mutations].sort((a, b) => b.seq - a.seq)

  for (const mut of sorted) {
    switch (mut.type) {
      case "drop":
        events = events.filter((e) => e.seq !== mut.seq)
        break
      case "replace": {
        const idx = events.findIndex((e) => e.seq === mut.seq)
        if (idx >= 0) {
          events[idx] = { ...events[idx], event: mut.event }
        }
        break
      }
      case "inject": {
        const insertIdx = events.findIndex((e) => e.seq >= mut.seq)
        const entry = {
          seq: mut.seq,
          event: mut.event,
          timestamp: new Date().toISOString(),
        }
        if (insertIdx >= 0) {
          events.splice(insertIdx, 0, entry)
        } else {
          events.push(entry)
        }
        break
      }
    }
  }

  // Re-number sequences
  events = events.map((e, i) => ({ ...e, seq: i }))

  return { runId: trajectory.runId, events }
}

// ── State machine validation ─────────────────────────────────────

/**
 * Valid transitions in the agent state machine:
 *
 *   goal → thinking | tool-call | answer | error | iteration
 *   thinking → tool-call | answer | error | delegation-start | iteration | thinking
 *   tool-call → tool-result | tool-error | delegation-start (delegate tool starts child)
 *   tool-result → thinking | tool-call | answer | iteration | error | delegation-start
 *   tool-error → thinking | tool-call | answer | error | iteration
 *   iteration → thinking | tool-call | answer | error
 *   delegation-start → delegation-end | delegation-start (parallel children) | tool-call | thinking | delegation-iteration | iteration
 *   delegation-iteration → delegation-start | delegation-end | tool-call | thinking | delegation-iteration | iteration
 *   delegation-end → thinking | tool-call | answer | iteration | delegation-start | delegation-end | tool-result
 *   answer → (terminal)
 *   error → (terminal)
 *
 * NOTE: Delegation events interleave with child agent events in the flat trace.
 * The validator tracks delegation depth to be lenient about transitions within
 * nested delegation blocks, since child events follow their own state machine.
 */
const VALID_TRANSITIONS: Record<string, Set<string>> = {
  "goal":              new Set(["thinking", "tool-call", "answer", "error", "iteration"]),
  "thinking":          new Set(["tool-call", "answer", "error", "delegation-start", "iteration", "thinking"]),
  "tool-call":         new Set(["tool-result", "tool-error", "delegation-start"]),
  "tool-result":       new Set(["thinking", "tool-call", "answer", "iteration", "error", "delegation-start"]),
  "tool-error":        new Set(["thinking", "tool-call", "answer", "error", "iteration"]),
  "iteration":         new Set(["thinking", "tool-call", "answer", "error"]),
  "delegation-start":  new Set(["delegation-end", "delegation-start", "tool-call", "thinking", "delegation-iteration", "iteration"]),
  "delegation-iteration": new Set(["delegation-start", "delegation-end", "tool-call", "thinking", "delegation-iteration", "iteration"]),
  "delegation-end":    new Set(["thinking", "tool-call", "answer", "iteration", "delegation-start", "delegation-end", "tool-result"]),
}

export interface TransitionViolation {
  seq: number
  from: string
  to: string
  message: string
}

/** Validate all state transitions in a trajectory. */
export function validateTransitions(trajectory: Trajectory): TransitionViolation[] {
  const violations: TransitionViolation[] = []
  let delegationDepth = 0

  // "usage", "delegation-iteration", and "delegation-parallel-*" are
  // observability/meta events, not agent states. They can appear between any
  // pair of real states and should be transparent to the state machine validator.
  const META_KINDS = new Set(["usage", "delegation-iteration", "delegation-parallel-start", "delegation-parallel-end"])

  // Build a filtered view that only contains real state events for validation,
  // while preserving the original seq numbers for violation reporting.
  const stateEvents: Array<{ seq: number; kind: string }> = []
  for (const entry of trajectory.events) {
    if (!META_KINDS.has(entry.event.kind)) {
      stateEvents.push({ seq: entry.seq, kind: entry.event.kind })
    }
  }

  for (let i = 1; i < stateEvents.length; i++) {
    const prev = stateEvents[i - 1].kind
    const curr = stateEvents[i].kind

    // Track delegation nesting depth
    if (prev === "delegation-start") delegationDepth++
    if (curr === "delegation-end") delegationDepth = Math.max(0, delegationDepth - 1)

    // Inside a delegation block, child agent events follow their own internal
    // state machine. Skip strict validation — child events are interleaved in
    // the flat trace and can produce any valid agent transition sequence.
    if (delegationDepth > 0) continue

    // Terminal states should have nothing after them
    if (prev === "answer" || prev === "error") {
      violations.push({
        seq: stateEvents[i].seq,
        from: prev,
        to: curr,
        message: `Event after terminal state "${prev}"`,
      })
      continue
    }

    const valid = VALID_TRANSITIONS[prev]
    if (valid && !valid.has(curr)) {
      violations.push({
        seq: stateEvents[i].seq,
        from: prev,
        to: curr,
        message: `Invalid transition: "${prev}" → "${curr}"`,
      })
    }
  }

  return violations
}

// ── Replay with validation ───────────────────────────────────────

export interface ReplayResult {
  /** Did the replay complete without violations? */
  valid: boolean
  /** State transition violations found. */
  violations: TransitionViolation[]
  /** Generated scorecard. */
  scorecard: Scorecard
  /** The (possibly mutated) trajectory that was replayed. */
  trajectory: Trajectory
}

/**
 * Replay a trajectory with optional mutations and generate a scorecard.
 *
 * This is a "dry replay" — no LLM calls, no tool execution.
 * It walks through the recorded events, validates transitions,
 * and generates quality metrics.
 */
export function replay(
  runId: string,
  mutations?: Mutation[],
): ReplayResult {
  let trajectory = loadTrajectory(runId)
  if (mutations && mutations.length > 0) {
    trajectory = applyMutations(trajectory, mutations)
  }

  const violations = validateTransitions(trajectory)
  const scorecard = generateScorecard(trajectory)

  return {
    valid: violations.length === 0,
    violations,
    scorecard,
    trajectory,
  }
}

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

function generateScorecard(trajectory: Trajectory): Scorecard {
  const events = trajectory.events.map((e) => e.event)
  const toolCalls = events.filter((e) => e.kind === "tool-call") as ToolCallEvent[]
  const toolErrors = events.filter((e) => e.kind === "tool-error")
  const iterations = events.filter((e) => e.kind === "iteration")
  const thinkingEvents = events.filter((e) => e.kind === "thinking")
  const delegations = events.filter(
    (e) => e.kind === "delegation-start",
  )

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

// ── Comparison ───────────────────────────────────────────────────

export interface TrajectoryComparison {
  /** Both runs attempted the same goal? */
  sameGoal: boolean
  /** Overlap in tools used (Jaccard similarity 0–1). */
  toolOverlap: number
  /** Difference in tool call count. */
  toolCallDelta: number
  /** Difference in iteration count. */
  iterationDelta: number
  /** Difference in error rate. */
  errorRateDelta: number
  /** Which run was more efficient (fewer events per iteration)? */
  moreEfficient: "a" | "b" | "equal"
  /** Summary. */
  summary: string
}

/**
 * Compare two trajectories — useful for before/after analysis
 * or comparing different agent configurations on the same goal.
 */
export function compareTrajectories(
  runIdA: string,
  runIdB: string,
): TrajectoryComparison {
  const a = replay(runIdA)
  const b = replay(runIdB)

  const goalA = a.trajectory.events.find((e) => e.event.kind === "goal")
  const goalB = b.trajectory.events.find((e) => e.event.kind === "goal")
  const sameGoal = goalA && goalB
    ? (goalA.event as GoalEvent).text === (goalB.event as GoalEvent).text
    : false

  // Jaccard similarity of tools used
  const toolsA = new Set(a.scorecard.toolsUsed)
  const toolsB = new Set(b.scorecard.toolsUsed)
  const intersection = new Set([...toolsA].filter((t) => toolsB.has(t)))
  const union = new Set([...toolsA, ...toolsB])
  const toolOverlap = union.size > 0 ? intersection.size / union.size : 1

  const moreEfficient =
    a.scorecard.eventsPerIteration < b.scorecard.eventsPerIteration
      ? "a"
      : a.scorecard.eventsPerIteration > b.scorecard.eventsPerIteration
        ? "b"
        : "equal"

  const lines: string[] = []
  if (sameGoal) lines.push("Same goal.")
  lines.push(`Tool overlap: ${Math.round(toolOverlap * 100)}%`)
  lines.push(`Run A: ${a.scorecard.toolCalls} calls, ${a.scorecard.iterations} iterations`)
  lines.push(`Run B: ${b.scorecard.toolCalls} calls, ${b.scorecard.iterations} iterations`)
  if (a.scorecard.hasAnswer && b.scorecard.hasAnswer) {
    lines.push("Both produced an answer.")
  } else {
    if (a.scorecard.hasAnswer) lines.push("Only Run A produced an answer.")
    if (b.scorecard.hasAnswer) lines.push("Only Run B produced an answer.")
  }

  return {
    sameGoal,
    toolOverlap,
    toolCallDelta: a.scorecard.toolCalls - b.scorecard.toolCalls,
    iterationDelta: a.scorecard.iterations - b.scorecard.iterations,
    errorRateDelta: a.scorecard.errorRate - b.scorecard.errorRate,
    moreEfficient,
    summary: lines.join(" "),
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
