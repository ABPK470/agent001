// ============================================================================
// Pipeline execution types (extracted from types.ts)
// ============================================================================
import type { DelegationOutputValidationCode } from "../delegation/delegation-validation.js"
import type { ToolCallRecord } from "../recovery/recovery.js"

export type PipelineStepStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "skipped"

export type PipelineStepExecutionState =
  | "pending"
  | "running"
  | "executed"
  | "failed"
  | "skipped"

export type StepAcceptanceState =
  | "pending"
  | "pending_verification"
  | "accepted"
  | "repair_required"
  | "blocked"
  | "rejected"

/**
 * Typed failure classes for child agent failures (agenc-core pattern).
 * Used by the retry policy to determine appropriate recovery strategy.
 */
export type SubagentFailureClass =
  | "timeout"
  | "budget_exceeded"
  | "tool_misuse"
  | "blueprint_contract"
  | "syntax_error"
  | "spawn_error"
  | "cancelled"
  | "transient_provider_error"
  // Tool failed because a required platform integration (database, secret,
  // env var, external service) is not configured on this server. No amount
  // of agent action can repair this — only the operator can. Treated as
  // unrecoverable: skip retry, skip repair loop, surface a clean message.
  | "platform_unconfigured"
  | "unknown"

export interface VerificationAttempt {
  readonly toolName: string
  readonly target?: string
  readonly success: boolean
  readonly summary: string
}

export interface ChildExecutionResult {
  readonly status: "success" | "failed" | "blocked"
  readonly summary: string
  readonly producedArtifacts: readonly string[]
  readonly modifiedArtifacts: readonly string[]
  readonly verificationAttempts: readonly VerificationAttempt[]
  readonly unresolvedBlockers: readonly string[]
}

export interface ContractReconciliationFinding {
  readonly code: "forbidden_artifact_write" | "missing_required_output" | "hallucinated_artifact" | "unresolved_blocker" | "required_check_skipped"
  readonly severity: "warning" | "error"
  readonly message: string
  readonly artifactPaths: readonly string[]
}

export interface ContractReconciliationResult {
  readonly compliant: boolean
  readonly findings: readonly ContractReconciliationFinding[]
}

export interface PipelineStepResult {
  readonly name: string
  readonly status: PipelineStepStatus
  readonly executionState?: PipelineStepExecutionState
  readonly acceptanceState?: StepAcceptanceState
  readonly output?: string
  readonly error?: string
  /** Typed failure class for diagnostic/retry purposes. */
  readonly failureClass?: SubagentFailureClass
  readonly durationMs: number
  /** Structured tool call records from the child agent (if available). */
  readonly toolCalls?: readonly ToolCallRecord[]
  /** Child execution summary derived from tool activity. */
  readonly childResult?: ChildExecutionResult
  /** Artifacts created or modified by the step. */
  readonly producedArtifacts?: readonly string[]
  readonly modifiedArtifacts?: readonly string[]
  /** Verification attempts observed during step execution. */
  readonly verificationAttempts?: readonly VerificationAttempt[]
  /** Delegation contract validation code (if validation ran). */
  readonly validationCode?: DelegationOutputValidationCode
  /** Post-execution contract reconciliation result. */
  readonly reconciliation?: ContractReconciliationResult
}

export type PipelineStatus = "running" | "completed" | "failed"

export interface PipelineResult {
  readonly status: PipelineStatus
  readonly stepResults: ReadonlyMap<string, PipelineStepResult>
  readonly completedSteps: number
  readonly totalSteps: number
  readonly error?: string
}

// ============================================================================
// Verifier & circuit breaker (re-exported from types-verifier.ts)
// ============================================================================

export type {
    CircuitBreakerState, LegacyRetryPlan,
    PlannerRepairCompatibilityMode, RepairPlan, RepairPlanCompatibilityReport, RepairTask, VerificationEvidence, VerifierDecision, VerifierIssue, VerifierIssueSeverity, VerifierOutcome, VerifierOwnershipMode,
    VerifierRepairClass, VerifierStepAssessment, VerifierSystemCheck
} from "./types-verifier.js"
