/**
 * Planner types — structured task decomposition (agenc-core pattern).
 *
 * Complex tasks are decomposed into typed plans before execution.
 * Two step types:
 *   - deterministic_tool: exact tool call with known args
 *   - subagent_task: complex work delegated to a child agent with contracts
 *
 * @module
 */

// ============================================================================
// Planner decision
// ============================================================================

/**
 * Result of assessing whether a task needs planning.
 * Score >= 3 → planner path, otherwise direct tool loop.
 */
export interface PlannerDecision {
  readonly score: number
  readonly shouldPlan: boolean
  readonly reason: string
}

// ============================================================================
// Execution envelope — typed contract for child agents
// ============================================================================

/**
 * What the child is allowed to do with the filesystem.
 */
export type EffectClass =
  | "readonly"
  | "filesystem_write"
  | "filesystem_scaffold"
  | "shell"
  | "mixed"

/**
 * How the child's work should be verified.
 */
export type VerificationMode =
  | "none"
  | "browser_check"
  | "run_tests"
  | "mutation_required"
  | "deterministic_followup"

/**
 * Relationship between a step and an artifact (file/directory).
 */
export interface ArtifactRelation {
  readonly relationType: "read_dependency" | "write_owner"
  readonly artifactPath: string
}

/**
 * Shared state contract for multi-file implementations.
 * Exactly one owner step controls state mutation; other steps consume it.
 */
export interface SharedStateContract {
  readonly contractId: string
  readonly ownerStepName: string
  readonly ownerArtifactPath: string
  readonly schema: string
  readonly mutationPolicy: "owner-only"
}

export interface ChildRepairGoal {
  readonly issueCode: string
  readonly summary: string
  readonly severity: VerifierIssueSeverity
  readonly repairClass: VerifierRepairClass
  readonly confidence: number
  readonly ownershipMode: VerifierOwnershipMode
  readonly suspectedOwners: readonly string[]
  readonly primaryOwner?: string
  readonly affectedArtifacts: readonly string[]
  readonly sourceArtifacts: readonly string[]
  readonly guidance?: string
}

export interface ChildRepairPayload {
  readonly mode: "initial" | "repair" | "reverify" | "blocked"
  readonly goals: readonly ChildRepairGoal[]
  readonly dependencyGoals: readonly ChildRepairGoal[]
  readonly requiredAcceptedArtifacts: readonly string[]
  readonly unresolvedDependencyBlockers: readonly string[]
}

/**
 * The execution envelope: scoped permissions and contracts for a child agent.
 * This is what makes agenc-core's children produce quality work.
 */
export interface ExecutionEnvelope {
  /** Working directory root for the child. */
  readonly workspaceRoot: string
  /** Directories the child may read from. */
  readonly allowedReadRoots: readonly string[]
  /** Directories the child may write to. */
  readonly allowedWriteRoots: readonly string[]
  /** Explicit tool allowlist (least-privilege). */
  readonly allowedTools: readonly string[]
  /** Source files/specs the child must read first. */
  readonly requiredSourceArtifacts: readonly string[]
  /** Files/dirs the child is expected to create/modify. */
  readonly targetArtifacts: readonly string[]
  /** What kind of filesystem effects this child produces. */
  readonly effectClass: EffectClass
  /** How the parent will verify this child's output. */
  readonly verificationMode: VerificationMode
  /** Typed ownership relations between this step and artifacts. */
  readonly artifactRelations: readonly ArtifactRelation[]
  /** Role of this step in the workflow (writer, reviewer, validator, grounding). */
  readonly role?: StepRole
  /** Optional shared-state contract for multi-file workflows. */
  readonly sharedStateContract?: SharedStateContract
  /** Explicit write forbiddance beyond owned artifacts. */
  readonly forbiddenArtifacts?: readonly string[]
  /** Deterministic checks the child should run before completion. */
  readonly requiredChecks?: readonly string[]
  /** Upstream artifacts already accepted by verification and safe to rely on. */
  readonly upstreamAcceptedArtifacts?: readonly string[]
  /** Dependency blockers that prevent this step from completing. */
  readonly unresolvedDependencyBlockers?: readonly string[]
  /** Typed repair context for retries/reverification. */
  readonly repairContext?: ChildRepairPayload
}

// ============================================================================
// Step workflow metadata
// ============================================================================

export type StepRole = "writer" | "reviewer" | "validator" | "grounding"

export interface WorkflowStepContract {
  readonly role: StepRole
  readonly artifactRelations: readonly ArtifactRelation[]
}

// ============================================================================
// Plan steps
// ============================================================================

/**
 * A deterministic tool step — exact tool call with known arguments.
 * Used for things like: readFile, mkdir, bash install, etc.
 */
export interface DeterministicToolStep {
  readonly name: string
  readonly stepType: "deterministic_tool"
  /** Which step(s) must complete before this one. */
  readonly dependsOn?: readonly string[]
  /** Tool to call. */
  readonly tool: string
  /** Arguments to pass. */
  readonly args: Record<string, unknown>
  /** What to do on error: retry (default), skip, or abort the pipeline. */
  readonly onError?: "retry" | "skip" | "abort"
  /** Max retries for this step (default: 2). */
  readonly maxRetries?: number
}

/**
 * A subagent task step — complex work delegated to a child agent.
 * This is the heart of quality delegation.
 */
export interface SubagentTaskStep {
  readonly name: string
  readonly stepType: "subagent_task"
  /** Which step(s) must complete before this one. */
  readonly dependsOn?: readonly string[]
  /** What the child must accomplish. */
  readonly objective: string
  /** What context/inputs are available to the child. */
  readonly inputContract: string
  /** Measurable success conditions the verifier will check. */
  readonly acceptanceCriteria: readonly string[]
  /** Tools the child needs (explicit allowlist). */
  readonly requiredToolCapabilities: readonly string[]
  /** Human-readable context notes. */
  readonly contextRequirements: readonly string[]
  /** Scoped permissions for the child (workspace, tools, artifacts). */
  readonly executionContext: ExecutionEnvelope
  /** Max time/iterations hint (e.g., "5m", "15 iterations"). */
  readonly maxBudgetHint: string
  /** Whether this step can run in parallel with siblings. */
  readonly canRunParallel: boolean
  /** Workflow role and artifact ownership. */
  readonly workflowStep?: WorkflowStepContract
}

/** Union of all step types in a plan. */
export type PlanStep = DeterministicToolStep | SubagentTaskStep

// ============================================================================
// Dependency edge
// ============================================================================

export interface PlanEdge {
  readonly from: string
  readonly to: string
}

// ============================================================================
// The Plan itself
// ============================================================================

/**
 * A structured execution plan produced by the planner.
 */
export interface Plan {
  /** Why the planner chose this decomposition. */
  readonly reason: string
  /** Confidence score (0–1). */
  readonly confidence?: number
  /** Whether a final synthesis step is needed after all steps complete. */
  readonly requiresSynthesis: boolean
  /** Ordered steps (topological order recommended). */
  readonly steps: readonly PlanStep[]
  /** Explicit dependency edges between steps. */
  readonly edges: readonly PlanEdge[]
}

export interface ExecutionGraphNode {
  readonly stepName: string
  readonly stepType: PlanStep["stepType"]
  readonly dependsOn: readonly string[]
  readonly downstream: readonly string[]
}

export interface ArtifactOwnershipNode {
  readonly artifactPath: string
  readonly ownerStepName: string | null
  readonly consumerStepNames: readonly string[]
  readonly relationTypes: readonly ArtifactRelation["relationType"][]
}

export interface RuntimeEntityDescriptor {
  readonly id: string
  readonly entityType: "planner_run" | "pipeline_step" | "delegated_worker" | "verification_pass" | "repair_cycle"
  readonly parentId?: string
  readonly stepName?: string
}

export interface PlannerRuntimeModel {
  readonly executionGraph: ReadonlyMap<string, ExecutionGraphNode>
  readonly ownershipGraph: ReadonlyMap<string, ArtifactOwnershipNode>
  readonly stepAcceptedDependencies: ReadonlyMap<string, readonly string[]>
  readonly runtimeEntities: readonly RuntimeEntityDescriptor[]
}

// ============================================================================
// Plan validation
// ============================================================================

export type DiagnosticCategory = "parse" | "graph" | "contract" | "ownership" | "verification" | "policy"

/**
 * Severity controls whether a diagnostic blocks the pipeline:
 * - "error"   → structurally broken plan, pipeline cannot run (cycles, unknown tools)
 * - "warning" → advisory issue, pipeline proceeds but warning is injected into step objectives
 */
export type DiagnosticSeverity = "error" | "warning"

export interface PlanDiagnostic {
  readonly category: DiagnosticCategory
  readonly severity: DiagnosticSeverity
  readonly code: string
  readonly message: string
  readonly stepName?: string
  readonly details?: Record<string, unknown>
}

// ============================================================================
// Pipeline execution
// ============================================================================

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
  | "unknown"

import type { DelegationOutputValidationCode } from "../delegation-validation.js"
import type { ToolCallRecord } from "../recovery.js"

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
// Verifier
// ============================================================================

export type VerifierOutcome = "pass" | "retry" | "fail"

export type VerifierIssueSeverity = "warning" | "error" | "fatal"

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
  readonly source: "contract" | "deterministic" | "llm"
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
  readonly mode: "repair" | "reverify" | "blocked"
  readonly ownedIssues: readonly VerifierIssue[]
  readonly dependencyContext: readonly VerifierIssue[]
  readonly requiredAcceptedArtifacts: readonly string[]
}

export interface RepairPlan {
  readonly tasks: readonly RepairTask[]
  readonly rerunOrder: readonly string[]
  readonly skippedVerifiedSteps: readonly string[]
}

export interface LegacyRetryPlan {
  readonly tasks: readonly RepairTask[]
  readonly rerunOrder: readonly string[]
  readonly skippedVerifiedSteps: readonly string[]
}

export type PlannerRepairCompatibilityMode = "shadow" | "legacy" | "repair"

export interface RepairPlanCompatibilityReport {
  readonly mode: PlannerRepairCompatibilityMode
  readonly activePath: "legacy" | "repair"
  readonly diverged: boolean
  readonly divergenceScore: number
  readonly reasons: readonly string[]
  readonly legacyPlan: LegacyRetryPlan
  readonly repairPlan: RepairPlan
}

export interface VerifierStepAssessment {
  readonly stepName: string
  readonly outcome: VerifierOutcome
  readonly confidence: number
  readonly issues: readonly string[]
  readonly issueDetails?: readonly VerifierIssue[]
  readonly evidence?: readonly VerificationEvidence[]
  readonly retryable: boolean
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
