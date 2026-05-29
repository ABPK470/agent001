/**
 * Recovery hint system — ported from agenc-core's chat-executor-recovery.ts (2160 lines).
 *
 * After each tool call round, checks for known failure patterns and injects
 * targeted recovery hints so the LLM tries the RIGHT fix instead of blindly
 * retrying. Each hint is emitted at most once per run (tracked via emittedKeys).
 *
 * Implementation split:
 *   recovery.ts                    — orchestration + round-level hints
 *   recovery/per-call-hints.ts     — basic per-call pattern matching
 *   recovery-hints-advanced.ts     — advanced per-call patterns
 *   recovery-detectors.ts          — shared low-level detectors
 *
 * @module
 */

import { MAX_RUNTIME_SYSTEM_HINTS } from "../../../domain/agent-constants.js"
import {
    didToolCallFail,
    type ToolCallRecord,
} from "../../../tools/index.js"
import { inferRecoveryHint } from "./internal/build-per-call-hints.js"

// ============================================================================
// Types
// ============================================================================

export interface RecoveryHint {
  /** Dedup key — same key never emitted twice in one run. */
  key: string
  /** Human-readable advice injected as a system message. */
  message: string
}

// ============================================================================
// Main entry point
// ============================================================================

/**
 * Scan a round of tool calls for known failure patterns.
 * Returns recovery hints that haven't been emitted yet.
 */
export function buildRecoveryHints(
  roundCalls: readonly ToolCallRecord[],
  emittedHints: Set<string>,
): RecoveryHint[] {
  const hints: RecoveryHint[] = []

  // Round-level hint (cross-call patterns)
  const roundHint = inferRoundRecoveryHint(roundCalls)
  if (roundHint && !emittedHints.has(roundHint.key)) {
    emittedHints.add(roundHint.key)
    hints.push(roundHint)
  }

  // Per-call hints
  for (const call of roundCalls) {
    const hint = inferRecoveryHint(call)
    if (!hint) continue
    if (emittedHints.has(hint.key)) continue
    emittedHints.add(hint.key)
    hints.push(hint)
  }

  // Max 4 hints per round to avoid flooding context
  return hints.slice(0, MAX_RUNTIME_SYSTEM_HINTS)
}

// ============================================================================
// Round-level hints (cross-call patterns — ported from agenc-core)
// ============================================================================

function inferRoundRecoveryHint(roundCalls: readonly ToolCallRecord[]): RecoveryHint | undefined {
  // Detect delegation results that indicate the child needs decomposition
  const delegationNeedsDecomposition = roundCalls.find(call => {
    if (call.name !== "delegate" && call.name !== "delegate_parallel") return false
    if (!call.result.includes("Agent stopped after")) return false
    return true
  })
  if (delegationNeedsDecomposition) {
    return {
      key: "delegation-child-exhausted-budget",
      message:
        "A delegated child agent exhausted its iteration budget without completing the task. " +
        "The objective was too large for a single child. Split it into smaller, more focused " +
        "delegate calls, each with a narrower scope and clear acceptance criteria. " +
        "Do not retry the same combined task — decompose it.",
    }
  }

  // Detect all-fail rounds
  const allFailed = roundCalls.length > 0 && roundCalls.every(c => didToolCallFail(c.isError, c.result))
  if (allFailed && roundCalls.length >= 2) {
    return {
      key: "round-all-tools-failed",
      message:
        "Every tool call in this round failed. Stop and reassess your entire approach. " +
        "You may be working in the wrong directory, missing dependencies, or using the wrong tools. " +
        "Use list_directory or read_file to understand your current state before trying again.",
    }
  }

  return undefined
}
