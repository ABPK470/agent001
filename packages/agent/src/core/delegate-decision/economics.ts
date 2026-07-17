/**
 * Decomposition / coordination / latency economics. Pure function over the
 * decision input — no side effects.
 *
 * @module
 */

import { clamp01, type DelegationDecisionInput } from "./types.js"

export interface EconomicsResult {
  utilityScore: number
  decompositionBenefit: number
  coordinationOverhead: number
  latencyCostRisk: number
}

export function computeEconomics(input: DelegationDecisionInput): EconomicsResult {
  const parallelSteps = input.subagentSteps.filter((s) => s.canRunParallel).length
  const totalSteps = Math.max(1, input.subagentSteps.length)

  const parallelFraction = parallelSteps / totalSteps
  const decompositionBenefit = clamp01(
    0.3 * parallelFraction +
      0.3 * Math.min(1, input.complexityScore / 8) +
      0.2 * (input.subagentSteps.length >= 3 ? 1 : 0.5) +
      0.2 * (input.explicitDelegationRequested ? 1 : 0)
  )

  const dependentSteps = input.subagentSteps.filter((s) => s.dependsOn && s.dependsOn.length > 0).length
  const dependencyFraction = dependentSteps / totalSteps
  const coordinationOverhead = clamp01(
    0.3 * dependencyFraction +
      0.2 * (1 - parallelFraction) +
      0.1 * (input.synthesisSteps / Math.max(1, input.totalSteps))
  )

  const verifierCost = clamp01(0.1 * totalSteps)
  const retryCost = clamp01(0.08 * totalSteps)
  const latencyCostRisk = clamp01(verifierCost * 0.45 + retryCost * 0.45 + 0.1)

  const utilityScore = decompositionBenefit - coordinationOverhead * 0.4 - latencyCostRisk * 0.2

  return { utilityScore, decompositionBenefit, coordinationOverhead, latencyCostRisk }
}
