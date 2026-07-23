import { DiagnosticCategory, DiagnosticSeverity } from "../../domain/enums/planner.js"
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
  PlanExecutionMode,
  PlannerDecision,
  PlannerRoute
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

export type {
  DeterministicToolStep,
  PlanStep,
  SubagentTaskStep,
} from "../../domain/types/planner-delegate.js"

// ============================================================================
// Dependency edge
// ============================================================================

import type { PlannerRoute } from "./internal/types-decision.js"
import type { ArtifactRelation } from "./internal/types-execution.js"
import type { PlanStep } from "../../domain/types/planner-delegate.js"

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
