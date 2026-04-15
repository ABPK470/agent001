/**
 * Planner orchestrator — the main entry point for planned execution.
 *
 * Re-exports all planner sub-modules for backwards compatibility.
 *
 * @module
 */

export {
    createBudgetState, createCircuitBreaker, isBlocked, maybeExtendBudget, recordFailure,
    recordSuccess
} from "./circuit-breaker.js"
export type { BudgetState } from "./circuit-breaker.js"
export { assessPlannerDecision } from "./decision.js"
export { generateCoherentBootstrap, generatePlan } from "./generate.js"
export type { CoherentBootstrapGenerationResult, PlanGenerationContext, PlanGenerationResult } from "./generate.js"
export { inferForcedOutputDirectoryFromGoal } from "./index-normalize.js"
export { executePlannerPath } from "./index-orchestrator.js"
export type { PlannerContext, PlannerResult } from "./index-orchestrator.js"
export { synthesizeAnswer } from "./index-synthesize.js"
export { executePipeline } from "./pipeline.js"
export type { DelegateFn, DelegateResult, PipelineExecutorOptions, ToolExecFn } from "./pipeline.js"
export { validatePlan } from "./validate.js"
export type { ValidationResult } from "./validate.js"
export { runDeterministicProbes, runLLMVerification, verify } from "./verifier.js"

// Re-export all types
export type {
    ArchitecturePreservationStatus, ArtifactRelation, ChildExecutionResult, CircuitBreakerState, CoherentArchitectureArtifact, CoherentSharedContract, CoherentSolutionArtifact, CoherentSolutionBundle, CoherentSystemInvariant, DeterministicToolStep, DiagnosticCategory, DiagnosticSeverity, EffectClass, ExecutionEnvelope, LegacyRetryPlan, PipelineResult, PipelineStatus, PipelineStepExecutionState, PipelineStepResult, PipelineStepStatus, Plan, PlanDiagnostic, PlanEdge, PlannerCoherentBootstrap, PlannerDecision, PlannerNeedLevel, PlannerRepairCompatibilityMode, PlanStep, RepairPlan, RepairPlanCompatibilityReport, RepairTask, RoutingConfidence, StepAcceptanceState, StepRole, SubagentFailureClass, SubagentTaskStep, VerificationAttempt, VerificationEvidence, VerificationMode, VerifierDecision, VerifierIssue, VerifierOutcome,
    VerifierStepAssessment, WorkflowStepContract
} from "./types.js"

