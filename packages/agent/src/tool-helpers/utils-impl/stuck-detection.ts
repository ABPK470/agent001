/**
 * Stuck-loop detection across consecutive tool rounds.
 *
 * Three independent signals:
 *  1. Per-call: N consecutive identical failing calls (loopState).
 *  2. Per-round: N consecutive all-failed rounds (stuckState).
 *  3. Semantic: N consecutive rounds with the same semantic key set
 *     regardless of success (stuckState).
 *
 * @module
 */

import {
    MAX_CONSECUTIVE_ALL_FAILED_ROUNDS,
    MAX_CONSECUTIVE_IDENTICAL_FAILURES,
    MAX_CONSECUTIVE_SEMANTIC_DUPLICATE_ROUNDS,
} from "../../constants.js"
import type { ToolCallRecord } from "../result.js"
import { buildSemanticToolCallKey, didToolCallFail } from "../result.js"

/** Mutable state for per-call failure tracking within a tool round. */
export interface ToolLoopState {
  lastFailKey: string
  consecutiveFailCount: number
}

/** Mutable state for cross-round stuck detection. */
export interface RoundStuckState {
  consecutiveAllFailedRounds: number
  lastRoundSemanticKey: string
  consecutiveSemanticDuplicateRounds: number
}

export interface StuckDetectionResult {
  readonly shouldBreak: boolean
  readonly reason?: string
}

/**
 * Track per-call consecutive failure counting within the tool loop.
 */
export function trackToolCallFailureState(
  toolFailed: boolean,
  semanticToolKey: string,
  loopState: ToolLoopState,
): void {
  const failKey = toolFailed ? semanticToolKey : ""
  if (toolFailed && failKey === loopState.lastFailKey) {
    loopState.consecutiveFailCount++
  } else {
    loopState.lastFailKey = failKey
    loopState.consecutiveFailCount = toolFailed ? 1 : 0
  }
}

/**
 * Check for stuck tool-loop patterns across rounds. See module doc.
 */
export function checkToolLoopStuckDetection(
  roundCalls: readonly ToolCallRecord[],
  loopState: ToolLoopState,
  stuckState: RoundStuckState,
): StuckDetectionResult {
  // Level 1: per-call identical failure
  if (loopState.consecutiveFailCount >= MAX_CONSECUTIVE_IDENTICAL_FAILURES) {
    return {
      shouldBreak: true,
      reason: "Detected repeated semantically-equivalent failing tool calls",
    }
  }

  if (roundCalls.length === 0) {
    return { shouldBreak: false }
  }

  // Level 2: all-failed rounds
  const roundFailures = roundCalls.filter(c => didToolCallFail(c.isError, c.result)).length
  if (roundFailures === roundCalls.length) {
    stuckState.consecutiveAllFailedRounds++
  } else {
    stuckState.consecutiveAllFailedRounds = 0
  }
  if (stuckState.consecutiveAllFailedRounds >= MAX_CONSECUTIVE_ALL_FAILED_ROUNDS) {
    return {
      shouldBreak: true,
      reason: `All tool calls failed for ${MAX_CONSECUTIVE_ALL_FAILED_ROUNDS} consecutive rounds`,
    }
  }

  // Level 3: semantic duplicate rounds (same tools + args, regardless of success/failure)
  const roundSemanticKey = roundCalls
    .map(c => buildSemanticToolCallKey(c.name, c.args))
    .sort()
    .join("|")
  if (roundSemanticKey.length > 0 && roundSemanticKey === stuckState.lastRoundSemanticKey) {
    stuckState.consecutiveSemanticDuplicateRounds++
  } else {
    stuckState.consecutiveSemanticDuplicateRounds = 0
  }
  stuckState.lastRoundSemanticKey = roundSemanticKey
  if (stuckState.consecutiveSemanticDuplicateRounds >= MAX_CONSECUTIVE_SEMANTIC_DUPLICATE_ROUNDS) {
    return {
      shouldBreak: true,
      reason: "Detected repeated semantically equivalent tool rounds with no material progress",
    }
  }

  return { shouldBreak: false }
}
