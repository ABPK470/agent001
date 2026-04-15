/**
 * Delegation decision — safety gate, hard-block detection, economics assessment.
 *
 * Ported from agenc-core delegation-decision.ts, adapted for agent001's
 * type system and tool names.
 *
 * Controls whether a set of subagent steps should be delegated or kept inline.
 * 21 decision reason codes cover safety, economics, coupling, and structural limits.
 *
 * Safety/hard-block detection is in delegation-decision-safety.ts.
 *
 * @module
 */

import {
    computeSafetyRisk,
    detectHardBlockedTaskClass,
    type HardBlockedTaskClassMatch,
} from "./delegation-decision-safety.js"

// ============================================================================
// Decision reason codes (21 outcomes)
// ============================================================================

export type DelegationDecisionReason =
  | "delegation_disabled"
  | "no_subagent_steps"
  | "hard_blocked_task_class"
  | "trivial_request"
  | "single_hop_request"
  | "shared_context_review"
  | "shared_artifact_writer_inline"
  | "fanout_exceeded"
  | "depth_exceeded"
  | "handoff_confidence_below_threshold"
  | "safety_risk_high"
  | "score_below_threshold"
  | "missing_execution_envelope"
  | "parallel_gain_insufficient"
  | "dependency_coupling_high"
  | "tool_overlap_high"
  | "verifier_cost_high"
  | "retry_cost_high"
  | "negative_economics"
  | "no_safe_delegation_shape"
  | "approved"

// ============================================================================
// Hard-blocked task classes (wallet, crypto, destructive, credential)
// ============================================================================

export type DelegationHardBlockedTaskClass =
  | "wallet_signing"
  | "wallet_transfer"
  | "stake_or_rewards"
  | "destructive_host_mutation"
  | "credential_exfiltration"

export type DelegationHardBlockedMatchSource = "capability" | "text"

// ============================================================================
// Configuration
// ============================================================================

export interface DelegationDecisionConfig {
  readonly enabled?: boolean
  readonly scoreThreshold?: number
  readonly maxFanoutPerTurn?: number
  readonly maxDepth?: number
  readonly hardBlockedTaskClasses?: readonly DelegationHardBlockedTaskClass[]
}

export interface ResolvedDelegationDecisionConfig {
  readonly enabled: boolean
  readonly scoreThreshold: number
  readonly maxFanoutPerTurn: number
  readonly maxDepth: number
  readonly hardBlockedTaskClasses: ReadonlySet<DelegationHardBlockedTaskClass>
}

// ============================================================================
// Step profile (what a subagent step looks like for decision purposes)
// ============================================================================

export interface DelegationSubagentStepProfile {
  readonly name: string
  readonly objective?: string
  readonly dependsOn?: readonly string[]
  readonly acceptanceCriteria: readonly string[]
  readonly requiredToolCapabilities: readonly string[]
  readonly canRunParallel: boolean
  readonly effectClass?: "read_only" | "write" | "mixed"
}

// ============================================================================
// Decision input & output
// ============================================================================

export interface DelegationDecisionInput {
  readonly messageText: string
  readonly explicitDelegationRequested?: boolean
  readonly plannerConfidence?: number
  readonly complexityScore: number
  readonly totalSteps: number
  readonly synthesisSteps: number
  readonly subagentSteps: readonly DelegationSubagentStepProfile[]
  readonly config?: DelegationDecisionConfig
  readonly currentDepth?: number
}

export interface DelegationDecision {
  readonly shouldDelegate: boolean
  readonly reason: DelegationDecisionReason
  readonly threshold: number
  readonly utilityScore: number
  readonly decompositionBenefit: number
  readonly coordinationOverhead: number
  readonly latencyCostRisk: number
  readonly safetyRisk: number
  readonly confidence: number
  readonly hardBlockedTaskClass: DelegationHardBlockedTaskClass | null
  readonly hardBlockedTaskClassSource: DelegationHardBlockedMatchSource | null
  readonly hardBlockedTaskClassSignal: string | null
  readonly diagnostics: Readonly<Record<string, number | boolean | string>>
}

// ============================================================================
// Defaults
// ============================================================================

const DEFAULT_SCORE_THRESHOLD = 0.2
const DEFAULT_MAX_FANOUT_PER_TURN = 8
const DEFAULT_MAX_DEPTH = 4
const SAFETY_RISK_HARD_BLOCK_THRESHOLD = 0.9

const DEFAULT_HARD_BLOCKED_TASK_CLASSES: readonly DelegationHardBlockedTaskClass[] = [
  "wallet_signing",
  "wallet_transfer",
  "stake_or_rewards",
  "credential_exfiltration",
]

// ============================================================================
// Config resolution
// ============================================================================

export function resolveDelegationDecisionConfig(
  config?: DelegationDecisionConfig,
): ResolvedDelegationDecisionConfig {
  const hardBlockedTaskClasses = new Set<DelegationHardBlockedTaskClass>()
  const configured = config?.hardBlockedTaskClasses
  if (Array.isArray(configured)) {
    for (const tc of configured) {
      if (isValidHardBlockedClass(tc)) hardBlockedTaskClasses.add(tc)
    }
  } else {
    for (const tc of DEFAULT_HARD_BLOCKED_TASK_CLASSES) {
      hardBlockedTaskClasses.add(tc)
    }
  }
  return {
    enabled: config?.enabled ?? true,
    scoreThreshold: clamp01(config?.scoreThreshold ?? DEFAULT_SCORE_THRESHOLD),
    maxFanoutPerTurn: Math.max(1, Math.floor(config?.maxFanoutPerTurn ?? DEFAULT_MAX_FANOUT_PER_TURN)),
    maxDepth: Math.max(1, Math.floor(config?.maxDepth ?? DEFAULT_MAX_DEPTH)),
    hardBlockedTaskClasses,
  }
}

// ============================================================================
// Main decision function
// ============================================================================

/**
 * Assess whether a delegation should proceed based on safety, economics,
 * structural limits, and hard-block checks.
 */
export function assessDelegationDecision(
  input: DelegationDecisionInput,
): DelegationDecision {
  const resolvedConfig = resolveDelegationDecisionConfig(input.config)
  const hardBlockedMatch = detectHardBlockedTaskClass(input, resolvedConfig)
  const safetyRisk = computeSafetyRisk(input.subagentSteps)
  const plannerConfidence = clamp01(input.plannerConfidence ?? 0)

  // Gate 1: delegation disabled
  if (!resolvedConfig.enabled) {
    return buildDecision({
      shouldDelegate: false,
      reason: "delegation_disabled",
      resolvedConfig,
      safetyRisk,
      confidence: plannerConfidence,
      hardBlockedMatch,
    })
  }

  // Gate 2: no subagent steps
  if (input.subagentSteps.length === 0) {
    return buildDecision({
      shouldDelegate: false,
      reason: "no_subagent_steps",
      resolvedConfig,
      safetyRisk,
      confidence: plannerConfidence,
      hardBlockedMatch,
    })
  }

  // Gate 3: hard-blocked task class
  if (hardBlockedMatch) {
    return buildDecision({
      shouldDelegate: false,
      reason: "hard_blocked_task_class",
      resolvedConfig,
      safetyRisk,
      confidence: plannerConfidence,
      hardBlockedMatch,
    })
  }

  // Gate 4: safety risk above hard-block threshold
  if (safetyRisk >= SAFETY_RISK_HARD_BLOCK_THRESHOLD) {
    return buildDecision({
      shouldDelegate: false,
      reason: "safety_risk_high",
      resolvedConfig,
      safetyRisk,
      confidence: plannerConfidence,
      hardBlockedMatch,
    })
  }

  // Gate 5: fanout exceeded
  if (input.subagentSteps.length > resolvedConfig.maxFanoutPerTurn) {
    return buildDecision({
      shouldDelegate: false,
      reason: "fanout_exceeded",
      resolvedConfig,
      safetyRisk,
      confidence: plannerConfidence,
      hardBlockedMatch,
    })
  }

  // Gate 6: depth exceeded
  if ((input.currentDepth ?? 0) >= resolvedConfig.maxDepth) {
    return buildDecision({
      shouldDelegate: false,
      reason: "depth_exceeded",
      resolvedConfig,
      safetyRisk,
      confidence: plannerConfidence,
      hardBlockedMatch,
    })
  }

  // Economics assessment
  const { utilityScore, decompositionBenefit, coordinationOverhead, latencyCostRisk } =
    computeEconomics(input)

  // Gate 7: score below threshold
  if (utilityScore < resolvedConfig.scoreThreshold) {
    return buildDecision({
      shouldDelegate: false,
      reason: "score_below_threshold",
      resolvedConfig,
      utilityScore,
      decompositionBenefit,
      coordinationOverhead,
      latencyCostRisk,
      safetyRisk,
      confidence: plannerConfidence,
      hardBlockedMatch,
    })
  }

  // Gate 8: dependency coupling too high
  if (coordinationOverhead > 0.7) {
    return buildDecision({
      shouldDelegate: false,
      reason: "dependency_coupling_high",
      resolvedConfig,
      utilityScore,
      decompositionBenefit,
      coordinationOverhead,
      latencyCostRisk,
      safetyRisk,
      confidence: plannerConfidence,
      hardBlockedMatch,
    })
  }

  // Gate 9: negative economics (cost exceeds benefit)
  if (utilityScore < 0) {
    return buildDecision({
      shouldDelegate: false,
      reason: "negative_economics",
      resolvedConfig,
      utilityScore,
      decompositionBenefit,
      coordinationOverhead,
      latencyCostRisk,
      safetyRisk,
      confidence: plannerConfidence,
      hardBlockedMatch,
    })
  }

  // APPROVED
  const confidence = clamp01(
    0.25 +
      plannerConfidence * 0.35 +
      (input.subagentSteps.length > 1 ? 0.2 : 0.1) +
      (1 - safetyRisk) * 0.2,
  )

  return buildDecision({
    shouldDelegate: true,
    reason: "approved",
    resolvedConfig,
    utilityScore,
    decompositionBenefit,
    coordinationOverhead,
    latencyCostRisk,
    safetyRisk,
    confidence,
    hardBlockedMatch,
  })
}

// ============================================================================
// Economics
// ============================================================================

function computeEconomics(input: DelegationDecisionInput): {
  utilityScore: number
  decompositionBenefit: number
  coordinationOverhead: number
  latencyCostRisk: number
} {
  const parallelSteps = input.subagentSteps.filter(s => s.canRunParallel).length
  const totalSteps = Math.max(1, input.subagentSteps.length)

  const parallelFraction = parallelSteps / totalSteps
  const decompositionBenefit = clamp01(
    0.3 * parallelFraction +
      0.3 * Math.min(1, input.complexityScore / 8) +
      0.2 * (input.subagentSteps.length >= 3 ? 1 : 0.5) +
      0.2 * (input.explicitDelegationRequested ? 1 : 0),
  )

  const dependentSteps = input.subagentSteps.filter(s => s.dependsOn && s.dependsOn.length > 0).length
  const dependencyFraction = dependentSteps / totalSteps
  const coordinationOverhead = clamp01(
    0.3 * dependencyFraction +
      0.2 * (1 - parallelFraction) +
      0.1 * (input.synthesisSteps / Math.max(1, input.totalSteps)),
  )

  const verifierCost = clamp01(0.1 * totalSteps)
  const retryCost = clamp01(0.08 * totalSteps)
  const latencyCostRisk = clamp01(verifierCost * 0.45 + retryCost * 0.45 + 0.1)

  const utilityScore = decompositionBenefit - coordinationOverhead * 0.4 - latencyCostRisk * 0.2

  return { utilityScore, decompositionBenefit, coordinationOverhead, latencyCostRisk }
}

// ============================================================================
// Decision builder
// ============================================================================

function buildDecision(input: {
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
}): DelegationDecision {
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

// ============================================================================
// Helpers
// ============================================================================

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

function isValidHardBlockedClass(value: string): value is DelegationHardBlockedTaskClass {
  return value === "wallet_signing" || value === "wallet_transfer" ||
    value === "stake_or_rewards" || value === "destructive_host_mutation" ||
    value === "credential_exfiltration"
}
