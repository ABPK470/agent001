/**
 * Delegation decision — safety gate, hard-block detection, economics assessment.
 *
 * Controls whether a set of subagent steps should be delegated or kept inline.
 * 21 decision reason codes cover safety, economics, coupling, and structural limits.
 *
 * Internals split into ./decision/<module>:
 *   types          — type definitions, default constants, clamp helpers
 *   config         — resolveDelegationDecisionConfig
 *   economics      — computeEconomics (decomposition / coordination / latency)
 *   build-decision — DelegationDecision record builder
 *
 * Safety/hard-block detection lives in delegation-decision-safety.ts.
 *
 * @module
 */

import { computeSafetyRisk, detectHardBlockedTaskClass } from "../check-decision-safety.js"
import { buildDecision } from "./build-decision.js"
import { resolveDelegationDecisionConfig } from "./config.js"
import { computeEconomics } from "./economics.js"
import {
  SAFETY_RISK_HARD_BLOCK_THRESHOLD,
  clamp01,
  type DelegationDecision,
  type DelegationDecisionInput
} from "./types.js"

// Public re-exports preserve original shape
export { resolveDelegationDecisionConfig } from "./config.js"
export type {
  DelegationDecision,
  DelegationDecisionConfig,
  DelegationDecisionInput,
  DelegationDecisionReason,
  DelegationHardBlockedMatchSource,
  DelegationHardBlockedTaskClass,
  DelegationSubagentStepProfile,
  ResolvedDelegationDecisionConfig
} from "./types.js"

/**
 * Assess whether a delegation should proceed based on safety, economics,
 * structural limits, and hard-block checks.
 */
export function assessDelegationDecision(input: DelegationDecisionInput): DelegationDecision {
  const resolvedConfig = resolveDelegationDecisionConfig(input.config)
  const hardBlockedMatch = detectHardBlockedTaskClass(input, resolvedConfig)
  const safetyRisk = computeSafetyRisk(input.subagentSteps)
  const plannerConfidence = clamp01(input.plannerConfidence ?? 0)

  const baseDecision = {
    resolvedConfig,
    safetyRisk,
    confidence: plannerConfidence,
    hardBlockedMatch
  }

  // Gate 1: delegation disabled
  if (!resolvedConfig.enabled) {
    return buildDecision({ shouldDelegate: false, reason: "delegation_disabled", ...baseDecision })
  }

  // Gate 2: no subagent steps
  if (input.subagentSteps.length === 0) {
    return buildDecision({ shouldDelegate: false, reason: "no_subagent_steps", ...baseDecision })
  }

  // Gate 3: hard-blocked task class
  if (hardBlockedMatch) {
    return buildDecision({ shouldDelegate: false, reason: "hard_blocked_task_class", ...baseDecision })
  }

  // Gate 4: safety risk above hard-block threshold
  if (safetyRisk >= SAFETY_RISK_HARD_BLOCK_THRESHOLD) {
    return buildDecision({ shouldDelegate: false, reason: "safety_risk_high", ...baseDecision })
  }

  // Gate 5: fanout exceeded
  if (input.subagentSteps.length > resolvedConfig.maxFanoutPerTurn) {
    return buildDecision({ shouldDelegate: false, reason: "fanout_exceeded", ...baseDecision })
  }

  // Gate 6: depth exceeded
  if ((input.currentDepth ?? 0) >= resolvedConfig.maxDepth) {
    return buildDecision({ shouldDelegate: false, reason: "depth_exceeded", ...baseDecision })
  }

  // Economics assessment
  const econ = computeEconomics(input)

  // Gate 7: score below threshold
  if (econ.utilityScore < resolvedConfig.scoreThreshold) {
    return buildDecision({
      shouldDelegate: false,
      reason: "score_below_threshold",
      ...baseDecision,
      ...econ
    })
  }

  // Gate 8: dependency coupling too high
  if (econ.coordinationOverhead > 0.7) {
    return buildDecision({
      shouldDelegate: false,
      reason: "dependency_coupling_high",
      ...baseDecision,
      ...econ
    })
  }

  // Gate 9: negative economics (cost exceeds benefit)
  if (econ.utilityScore < 0) {
    return buildDecision({
      shouldDelegate: false,
      reason: "negative_economics",
      ...baseDecision,
      ...econ
    })
  }

  // APPROVED
  const confidence = clamp01(
    0.25 + plannerConfidence * 0.35 + (input.subagentSteps.length > 1 ? 0.2 : 0.1) + (1 - safetyRisk) * 0.2
  )

  return buildDecision({
    shouldDelegate: true,
    reason: "approved",
    resolvedConfig,
    safetyRisk,
    confidence,
    hardBlockedMatch,
    ...econ
  })
}
