/**
 * Decision-record builder. Centralizes shape so every gate produces an
 * identically-typed DelegationDecision regardless of how many fields it
 * actually has signal for.
 *
 * @module
 */

import type { HardBlockedTaskClassMatch } from "../delegation-decision-safety.js"
import type {
    DelegationDecision,
    DelegationDecisionReason,
    ResolvedDelegationDecisionConfig,
} from "./types.js"

export interface BuildDecisionInput {
  readonly shouldDelegate: boolean
  readonly reason: DelegationDecisionReason
  readonly resolvedConfig: ResolvedDelegationDecisionConfig
  readonly utilityScore?: number
  readonly decompositionBenefit?: number
  readonly coordinationOverhead?: number
  readonly latencyCostRisk?: number
  readonly safetyRisk: number
  readonly confidence: number
  readonly hardBlockedMatch: HardBlockedTaskClassMatch | null
}

export function buildDecision(input: BuildDecisionInput): DelegationDecision {
  return {
    shouldDelegate: input.shouldDelegate,
    reason: input.reason,
    threshold: input.resolvedConfig.scoreThreshold,
    utilityScore: input.utilityScore ?? 0,
    decompositionBenefit: input.decompositionBenefit ?? 0,
    coordinationOverhead: input.coordinationOverhead ?? 0,
    latencyCostRisk: input.latencyCostRisk ?? 0,
    safetyRisk: input.safetyRisk,
    confidence: input.confidence,
    hardBlockedTaskClass: input.hardBlockedMatch?.taskClass ?? null,
    hardBlockedTaskClassSource: input.hardBlockedMatch?.source ?? null,
    hardBlockedTaskClassSignal: input.hardBlockedMatch?.signal ?? null,
    diagnostics: {
      threshold: input.resolvedConfig.scoreThreshold,
      enabled: input.resolvedConfig.enabled,
      maxFanoutPerTurn: input.resolvedConfig.maxFanoutPerTurn,
      maxDepth: input.resolvedConfig.maxDepth,
      hasHardBlockedTaskClass: input.hardBlockedMatch !== null,
    },
  }
}
