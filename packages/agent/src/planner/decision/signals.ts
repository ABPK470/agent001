/**
 * Signal collection and routing confidence scoring for the planner decision system.
 *
 * @module
 */

import type { Message } from "../../types.js"
import {
    BOUNDED_COHERENT_SCOPE_RE,
    COHERENCE_FIRST_RE,
    COHESIVE_IMPLEMENTATION_RE,
    COORDINATION_HEAVY_RE,
    DELEGATION_RE,
    EXISTING_CODE_COUPLING_RE,
    IMPLEMENTATION_SCOPE_RE,
    MULTI_STEP_RE,
    MULTI_TARGET_CUE_RE,
    RECOVERY_HINT_RE,
    TARGET_FILE_RE,
    TOOL_DIVERSITY_RE,
    VERIFICATION_RE,
} from "../decision-patterns.js"
import type { PlannerNeedLevel, RoutingConfidence } from "../types.js"

// ============================================================================
// Structured signal collection
// ============================================================================

export interface RequestSignals {
  readonly normalized: string
  readonly hasMultiStepCue: boolean
  readonly hasToolDiversityCue: boolean
  readonly hasDelegationCue: boolean
  readonly hasImplementationScopeCue: boolean
  readonly hasVerificationCue: boolean
  readonly longTask: boolean
  readonly structuredBulletCount: number
  readonly priorToolMessages: number
  readonly targetFilePaths: readonly string[]
  /** True when recent history contains a no-progress / recovery marker → favour planner */
  readonly hasPriorNoProgressSignal: boolean
}

export interface RoutingAxes {
  readonly coherenceScore: number
  readonly coordinationScore: number
  readonly coherenceNeed: PlannerNeedLevel
  readonly coordinationNeed: PlannerNeedLevel
}

export function collectSignals(messageText: string, history: readonly Message[]): RequestSignals {
  const normalized = messageText.trim()
  const bulletCount = (normalized.match(/^[\s]*[-*•]\s/gm) ?? []).length
    + (normalized.match(/^\s*\d+[.)]\s/gm) ?? []).length

  const priorToolMessages = history.filter(m => m.role === "tool").length
  const targetFilePaths = [...new Set((normalized.match(TARGET_FILE_RE) ?? []).map(p => p.replace(/^\.\//, "")))]
  const historyTail = history.slice(-10)
  const hasPriorNoProgressSignal = historyTail.some(
    m => typeof m.content === "string" && RECOVERY_HINT_RE.test(m.content),
  )

  return {
    normalized,
    hasMultiStepCue: MULTI_STEP_RE.test(normalized),
    hasToolDiversityCue: TOOL_DIVERSITY_RE.test(normalized),
    hasDelegationCue: DELEGATION_RE.test(normalized),
    hasImplementationScopeCue: IMPLEMENTATION_SCOPE_RE.test(normalized),
    hasVerificationCue: VERIFICATION_RE.test(normalized),
    longTask: normalized.length > 200 || bulletCount >= 3,
    structuredBulletCount: bulletCount,
    priorToolMessages,
    targetFilePaths,
    hasPriorNoProgressSignal,
  }
}

export function isHighConfidenceSingleArtifactBurst(signals: RequestSignals): boolean {
  const explicitSingleArtifact = /\b(?:single|one|only)\s+(?:file|module|component|page|script)\b/i.test(signals.normalized)
  if (!explicitSingleArtifact) return false
  if (signals.targetFilePaths.length !== 1) return false
  if (signals.hasDelegationCue || signals.hasMultiStepCue) return false
  if (signals.structuredBulletCount > 0) return false
  if (MULTI_TARGET_CUE_RE.test(signals.normalized)) return false
  return signals.hasImplementationScopeCue || COHESIVE_IMPLEMENTATION_RE.test(signals.normalized)
}

export function toNeedLevel(score: number): PlannerNeedLevel {
  if (score >= 5) return "high"
  if (score >= 3) return "medium"
  return "low"
}

export function hasRealOwnershipSeparation(signals: RequestSignals): boolean {
  return signals.hasMultiStepCue
    || signals.hasDelegationCue
    || signals.structuredBulletCount > 0
    || MULTI_TARGET_CUE_RE.test(signals.normalized)
    || COORDINATION_HEAVY_RE.test(signals.normalized)
}

export function evaluateRoutingAxes(signals: RequestSignals): RoutingAxes {
  let coherenceScore = 0
  let coordinationScore = 0

  if (signals.hasImplementationScopeCue) coherenceScore += 3
  if (COHESIVE_IMPLEMENTATION_RE.test(signals.normalized)) coherenceScore += 2
  if (COHERENCE_FIRST_RE.test(signals.normalized)) coherenceScore += 2
  if (BOUNDED_COHERENT_SCOPE_RE.test(signals.normalized)) coherenceScore += 1
  if (signals.longTask) coherenceScore += 1
  if (signals.targetFilePaths.length >= 2) coherenceScore += 1

  if (signals.hasMultiStepCue) coordinationScore += 3
  if (signals.hasDelegationCue) coordinationScore += 4
  if (signals.structuredBulletCount > 0) coordinationScore += 2
  if (signals.targetFilePaths.length >= 2) coordinationScore += 2
  if (EXISTING_CODE_COUPLING_RE.test(signals.normalized)) coordinationScore += 3
  if (COORDINATION_HEAVY_RE.test(signals.normalized)) coordinationScore += 3
  if (signals.priorToolMessages >= 4) coordinationScore += 1
  if (MULTI_TARGET_CUE_RE.test(signals.normalized)) coordinationScore += 1

  if (EXISTING_CODE_COUPLING_RE.test(signals.normalized)) {
    coherenceScore = Math.max(0, coherenceScore - 1)
  }

  return {
    coherenceScore,
    coordinationScore,
    coherenceNeed: toNeedLevel(coherenceScore),
    coordinationNeed: toNeedLevel(coordinationScore),
  }
}

// ============================================================================
// Layer 3: Routing confidence scoring
// ============================================================================

/**
 * Score how confident the heuristic layer is about its routing recommendation.
 *
 * The confidence level controls whether Layer 4 (LLM routing) is invoked:
 * - "ambiguous" → escalate to LLM (signals are contradictory or weak)
 * - anything else → skip LLM router, heuristic is reliable enough
 *
 * Criteria:
 *   decisive_planner  — multi-step + delegation/bullets, OR coordinationNeed=high
 *   lean_planner      — medium coordination with at least one non-delegation
 *                       hard signal (multi-step, bullets, coupling, or
 *                       coordination_heavy pattern)
 *   ambiguous         — medium coordination came predominantly from DELEGATION_RE
 *                       alone with no supporting multi-step or structural signals;
 *                       regex fired but its semantic accuracy is uncertain
 *   lean_coherent     — low coordination + bounded implementation scope
 *   decisive_coherent — low coordination + strong coherence markers
 */
export function computeRoutingConfidence(signals: RequestSignals, axes: RoutingAxes): RoutingConfidence {
  if (axes.coordinationNeed === "high") return "decisive_planner"
  if (signals.hasMultiStepCue && (signals.hasDelegationCue || signals.structuredBulletCount > 0)) return "decisive_planner"

  if (axes.coordinationNeed === "medium") {
    // At least one hard non-delegation coordination signal → lean planner
    if (signals.hasMultiStepCue) return "lean_planner"
    if (signals.structuredBulletCount > 0) return "lean_planner"
    if (EXISTING_CODE_COUPLING_RE.test(signals.normalized)) return "lean_planner"
    if (COORDINATION_HEAVY_RE.test(signals.normalized)) return "lean_planner"
    // Coordination score is medium but only from DELEGATION_RE: ambiguous
    return "ambiguous"
  }

  // coordinationNeed === "low"
  if (COHESIVE_IMPLEMENTATION_RE.test(signals.normalized) || COHERENCE_FIRST_RE.test(signals.normalized)) {
    return "decisive_coherent"
  }
  if (signals.hasImplementationScopeCue && BOUNDED_COHERENT_SCOPE_RE.test(signals.normalized)) {
    return "lean_coherent"
  }
  return "ambiguous"
}
