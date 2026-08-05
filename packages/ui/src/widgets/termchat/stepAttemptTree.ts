/**
 * Chat step-tree presentation — rail depth and attempt labels.
 *
 * Semantic contract (must match schema-layer tools visually):
 *   step
 *   ├─ attempt          ← rail "step" (peer of Blocked / Queried)
 *   │  ├─ tool          ← rail "attempt" (+12px nest)
 *   │  └─ tool
 *   └─ attempt
 *      └─ tool
 *
 * Nested knee offset must equal nest width — otherwise the child rail
 * lands in the primary gutter and attempts read as floating headers.
 */

import type {
  ResponseStepAttemptPart,
  ResponseStepBlockPart,
  ResponseToolPart,
} from "../../lib/events/build-chat-parts"
import { shouldShowStepCheckInChat } from "./stepOutcomeChrome"

/** Primary fold rail (same as tools under a plain Subagent). */
export type StepTreeRail = "step" | "attempt"

/** Nest tokens — keep CSS and tests on one contract. */
export const STEP_ATTEMPT_TREE = {
  /** Outer fold padding / primary knee (rem). */
  primaryKneeRem: 1.5,
  /** Tools under an attempt — 12px. */
  attemptNestRem: 0.75,
} as const

/**
 * Second-level knee offset must match nest width so the child rail sits
 * under the attempt label, not in the primary gutter.
 */
export function attemptChildKneeRem(
  nestRem: number = STEP_ATTEMPT_TREE.attemptNestRem,
): number {
  return nestRem
}

export function formatAttemptLabel(attempt: ResponseStepAttemptPart): string {
  const head = attempt.repair
    ? `Attempt ${attempt.attempt} (repair)`
    : `Attempt ${attempt.attempt}`
  if (attempt.status === "failed") {
    return attempt.detail ? `${head} — failed: ${attempt.detail}` : `${head} — failed`
  }
  if (attempt.status === "passed") {
    const dur =
      attempt.detail && !/^attempt\s+\d+/i.test(attempt.detail)
        ? ` · ${attempt.detail}`
        : ""
    return `${head} — passed${dur}`
  }
  return `${head} — running`
}

export type StepTreeToolNode = {
  role: "tool"
  /** Always nested under an attempt when mode is nested-attempts. */
  rail: "attempt"
  id: string
  tool: ResponseToolPart
}

export type StepTreeCheckNode = {
  role: "check"
  rail: "attempt"
  label: string
}

export type StepTreeAttemptNode = {
  role: "attempt"
  /** Peer of schema-layer tools — never a floating mid-offset header. */
  rail: "step"
  id: string
  attempt: number
  repair: boolean
  status: ResponseStepAttemptPart["status"]
  label: string
  durationMs?: number
  body?: string
  hasRunning: boolean
  children: Array<StepTreeToolNode | StepTreeCheckNode>
}

export type StepTreeFlatToolNode = {
  role: "tool"
  rail: "step"
  id: string
  tool: ResponseToolPart
}

export type NestedAttemptsTree = {
  mode: "nested-attempts"
  attempts: StepTreeAttemptNode[]
}

export type FlatToolsTree = {
  mode: "flat-tools"
  tools: StepTreeFlatToolNode[]
}

export type StepAttemptTree = NestedAttemptsTree | FlatToolsTree

/**
 * Project a step block into rail-aware tree nodes.
 * Callers render from this — tests lock the hierarchy, not class names.
 */
export function projectStepAttemptTree(
  part: ResponseStepBlockPart,
): StepAttemptTree {
  const attempts = part.attempts
  if (attempts && attempts.length > 0) {
    const showCheck = shouldShowStepCheckInChat(part.outcome)
    const checkAfter =
      part.check?.afterAttemptIndex ?? attempts.length - 1
    return {
      mode: "nested-attempts",
      attempts: attempts.map((attempt, index) => {
        const children: Array<StepTreeToolNode | StepTreeCheckNode> = attempt.tools.map(
          (tool) => ({
            role: "tool" as const,
            rail: "attempt" as const,
            id: tool.id,
            tool,
          }),
        )
        if (showCheck && part.check && checkAfter === index) {
          children.push({
            role: "check",
            rail: "attempt",
            label: part.check.label,
          })
        }
        return {
          role: "attempt" as const,
          rail: "step" as const,
          id: attempt.id,
          attempt: attempt.attempt,
          repair: attempt.repair,
          status: attempt.status,
          label: formatAttemptLabel(attempt),
          durationMs: attempt.durationMs,
          body: attempt.body,
          hasRunning: attempt.hasRunning,
          children,
        }
      }),
    }
  }
  return {
    mode: "flat-tools",
    tools: part.tools.map((tool) => ({
      role: "tool" as const,
      rail: "step" as const,
      id: tool.id,
      tool,
    })),
  }
}

/** Walk rails for assertions — every node reports where it hangs. */
export function collectRails(tree: StepAttemptTree): StepTreeRail[] {
  if (tree.mode === "flat-tools") return tree.tools.map((t) => t.rail)
  const rails: StepTreeRail[] = []
  for (const attempt of tree.attempts) {
    rails.push(attempt.rail)
    for (const child of attempt.children) rails.push(child.rail)
  }
  return rails
}
