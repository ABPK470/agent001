import { DelegationHardBlockedMatchSource } from "../../domain/enums/delegation.js"
/**
 * Type definitions for the delegation-decision pipeline.
 *
 * @module
 */

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

export type DelegationHardBlockedTaskClass =
  | "wallet_signing"
  | "wallet_transfer"
  | "stake_or_rewards"
  | "destructive_host_mutation"
  | "credential_exfiltration"

export type { DelegationHardBlockedMatchSource }

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

export interface DelegationSubagentStepProfile {
  readonly name: string
  readonly objective?: string
  readonly dependsOn?: readonly string[]
  readonly acceptanceCriteria: readonly string[]
  readonly requiredToolCapabilities: readonly string[]
  readonly canRunParallel: boolean
  readonly effectClass?: "read_only" | "write" | "mixed"
}

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

// ── Constants ──────────────────────────────────────────────

export const DEFAULT_SCORE_THRESHOLD = 0.2
export const DEFAULT_MAX_FANOUT_PER_TURN = 8
export const DEFAULT_MAX_DEPTH = 4
export const SAFETY_RISK_HARD_BLOCK_THRESHOLD = 0.9

export const DEFAULT_HARD_BLOCKED_TASK_CLASSES: readonly DelegationHardBlockedTaskClass[] = [
  "wallet_signing",
  "wallet_transfer",
  "stake_or_rewards",
  "credential_exfiltration",
]

// ── Numeric helpers ────────────────────────────────────────

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

export function isValidHardBlockedClass(value: string): value is DelegationHardBlockedTaskClass {
  return value === "wallet_signing" || value === "wallet_transfer" ||
    value === "stake_or_rewards" || value === "destructive_host_mutation" ||
    value === "credential_exfiltration"
}
