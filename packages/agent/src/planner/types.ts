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

// ============================================================================
// Plan validation
// ============================================================================

export type DiagnosticCategory = "parse" | "graph" | "contract" | "ownership" | "verification" | "policy"

export interface PlanDiagnostic {
  readonly category: DiagnosticCategory
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

export interface PipelineStepResult {
  readonly name: string
  readonly status: PipelineStepStatus
  readonly output?: string
  readonly error?: string
  readonly durationMs: number
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

export interface VerifierStepAssessment {
  readonly stepName: string
  readonly outcome: VerifierOutcome
  readonly confidence: number
  readonly issues: readonly string[]
  readonly retryable: boolean
}

export interface VerifierDecision {
  readonly overall: VerifierOutcome
  readonly confidence: number
  readonly steps: readonly VerifierStepAssessment[]
  readonly unresolvedItems: readonly string[]
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
