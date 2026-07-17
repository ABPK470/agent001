import {
  VerifierEvidenceSource,
  VerifierIssueSeverity,
  VerifierMode,
  VerifierOutcome
} from "../../../domain/enums/planner.js"
export {
  VerifierEvidenceSource,
  VerifierIssueSeverity,
  VerifierMode,
  VerifierOutcome
}
/**
 * Verifier types — verification outcomes, evidence, issues, repair plans.
 *
 * Extracted from types.ts for maintainability.
 *
 * @module
 */

// ============================================================================
// Verifier
// ============================================================================

export type VerifierOwnershipMode =
  | "deterministic_owner"
  | "shared_owners"
  | "integration_layer"
  | "planner_fault"
  | "ambiguous"

export type VerifierRepairClass =
  | "owner_implementation"
  | "integration_wiring"
  | "contract_drift"
  | "path_scope"
  | "runtime_failure"
  | "syntax_failure"
  | "placeholder_logic"
  | "verification_gap"

export interface VerificationEvidence {
  readonly id: string
  readonly stepName: string
  readonly source: VerifierEvidenceSource
  readonly kind: string
  readonly message: string
  readonly artifactPaths: readonly string[]
  readonly details?: Record<string, unknown>
}

export interface VerifierIssue {
  readonly code: string
  readonly severity: VerifierIssueSeverity
  readonly retryable: boolean
  readonly ownerStepName: string
  readonly confidence: number
  readonly ownershipMode: VerifierOwnershipMode
  readonly suspectedOwners: readonly string[]
  readonly primaryOwner?: string
  readonly affectedArtifacts: readonly string[]
  readonly sourceArtifacts?: readonly string[]
  readonly evidenceIds: readonly string[]
  readonly repairClass: VerifierRepairClass
  readonly summary: string
  readonly details?: Record<string, unknown>
}

export interface VerifierSystemCheck {
  readonly code: string
  readonly severity: VerifierIssueSeverity
  readonly summary: string
  readonly confidence: number
  readonly affectedStepNames: readonly string[]
  readonly affectedArtifacts: readonly string[]
}

export interface RepairTask {
  readonly stepName: string
  readonly mode: VerifierMode
  readonly ownedIssues: readonly VerifierIssue[]
  readonly dependencyContext: readonly VerifierIssue[]
  readonly requiredAcceptedArtifacts: readonly string[]
}

export interface RepairPlan {
  readonly tasks: readonly RepairTask[]
  readonly rerunOrder: readonly string[]
  readonly skippedVerifiedSteps: readonly string[]
}

export interface VerifierStepAssessment {
  readonly stepName: string
  readonly outcome: VerifierOutcome
  readonly confidence: number
  readonly issues: readonly string[]
  readonly issueDetails?: readonly VerifierIssue[]
  readonly evidence?: readonly VerificationEvidence[]
  readonly retryable: boolean
  /**
   * Definitive positive signals from deterministic probes (e.g. "run_tests: ✓",
   * "syntax: node --check ✓"). When populated the LLM verifier must not raise
   * "cannot verify completeness" or "truncated" blocking issues for these artifacts.
   */
  readonly positiveSignals?: readonly string[]
}

export interface VerifierDecision {
  readonly overall: VerifierOutcome
  readonly confidence: number
  readonly steps: readonly VerifierStepAssessment[]
  readonly unresolvedItems: readonly string[]
  readonly repairPlan?: RepairPlan
  readonly systemChecks?: readonly VerifierSystemCheck[]
}

// ============================================================================
// Circuit breaker
// ============================================================================

export interface CircuitBreakerState {
  /** tool+argsHash → consecutive failure count */
  readonly failures: Map<string, number>
  /** Currently tripped? */
  readonly open: boolean
  /** Reason it tripped. */
  readonly reason?: string
}
