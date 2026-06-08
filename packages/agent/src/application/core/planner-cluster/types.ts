import { DiagnosticCategory, DiagnosticSeverity } from "../domain/enums/planner.js"
export { DiagnosticCategory, DiagnosticSeverity }
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

// Re-export decision and execution envelope types from extracted modules.
export type {
  ArchitecturePreservationStatus,
  CoherentArchitectureArtifact,
  CoherentSharedContract,
  CoherentSolutionArtifact,
  CoherentSolutionBundle,
  CoherentSystemInvariant,
  PlannerCoherentBootstrap,
  PlannerDecision,
  PlannerNeedLevel,
  PlannerRoute,
  RoutingConfidence
} from "./internal/types-decision.js"
export type {
  ArtifactRelation,
  ChildRepairGoal,
  ChildRepairPayload,
  EffectClass,
  ExecutionEnvelope,
  SharedStateContract,
  StepRole,
  VerificationMode,
  WorkflowStepContract
} from "./internal/types-execution.js"

// ============================================================================
// Plan steps
// ============================================================================

import type { PlannerCoherentBootstrap, PlannerRoute } from "./internal/types-decision.js"
import type { ArtifactRelation, ExecutionEnvelope, WorkflowStepContract } from "./internal/types-execution.js"

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
  /** Route that produced this plan. */
  readonly route?: PlannerRoute
  /** Planner bootstrap that froze architecture before decomposition. */
  readonly coherentBootstrap?: PlannerCoherentBootstrap
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
  readonly entityType:
    | "planner_run"
    | "pipeline_step"
    | "delegated_worker"
    | "verification_pass"
    | "repair_cycle"
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

/**
 * Severity controls whether a diagnostic blocks the pipeline:
 * - "error"   → structurally broken plan, pipeline cannot run (cycles, unknown tools)
 * - "warning" → advisory issue, pipeline proceeds but warning is injected into step objectives
 */
export interface PlanDiagnostic {
  readonly category: DiagnosticCategory
  readonly severity: DiagnosticSeverity
  readonly code: string
  readonly message: string
  readonly stepName?: string
  readonly details?: Record<string, unknown>
}

export * from "./internal/types-pipeline.js"
