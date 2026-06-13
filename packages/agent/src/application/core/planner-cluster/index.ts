/**
 * Planner orchestrator — the main entry point for planned execution.
 *
 * Re-exports all planner sub-modules for backwards compatibility.
 *
 * @module
 */

export {
  createBudgetState,
  createCircuitBreaker,
  isBlocked,
  maybeExtendBudget,
  recordFailure,
  recordSuccess
} from "./circuit-breaker.js"
export type { BudgetState } from "./circuit-breaker.js"
export { assessPlannerDecision } from "./decision/index.js"
export { generatePlan } from "./generate/index.js"
export type { PlanGenerationContext, PlanGenerationResult } from "./generate/index.js"
export { inferForcedOutputDirectoryFromGoal } from "./normalize/index.js"
export { executePlannerPath } from "./orchestrator/index.js"
export type { PlannerContext, PlannerResult } from "./orchestrator/index.js"
export { synthesizeAnswer } from "./synthesize.js"
export { executePipeline } from "./pipeline/index.js"
export type { DelegateFn, DelegateResult, PipelineExecutorOptions, ToolExecFn } from "./pipeline/index.js"
export { validatePlan } from "./validate/index.js"
export type { ValidationResult } from "./validate/index.js"
export { runDeterministicProbes, runLLMVerification, verify } from "./verifier/index.js"

// Additional public symbols (previously imported directly by tests / other clusters).
export { parseBlueprintContractBlock } from "./blueprint-contract/index.js"
export { isValidArtifactPath } from "./generate-parse/helpers.js"
export { isGibberishIssue } from "./pipeline-validation/index.js"
export { compilePlannerRuntime } from "./runtime-model.js"
export {
  buildRepairPlan,
  enrichVerifierAssessments
} from "./verification-model/index.js"
export { isLLMGibberish } from "./verifier-helpers/index.js"

// Platform-error helpers and failure polishing (used by server + lib.ts barrel).
export * from "./platform-errors.js"
export * from "./polish-failure.js"

// Re-export all types
export type {
  ArtifactRelation,
  ChildExecutionResult,
  CircuitBreakerState,
  CoherentSharedContract,
  CoherentSystemInvariant,
  DeterministicToolStep,
  DiagnosticCategory,
  DiagnosticSeverity,
  EffectClass,
  ExecutionEnvelope,
  LegacyRetryPlan,
  PipelineResult,
  PipelineStatus,
  PipelineStepExecutionState,
  PipelineStepResult,
  PipelineStepStatus,
  Plan,
  PlanDiagnostic,
  PlanEdge,
  PlannerDecision,
  PlannerRoute,
  PlanStep,
  RepairPlan,
  RepairTask,
  StepAcceptanceState,
  StepRole,
  SubagentFailureClass,
  SubagentTaskStep,
  VerificationAttempt,
  VerificationEvidence,
  VerificationMode,
  VerifierDecision,
  VerifierIssue,
  VerifierOutcome,
  VerifierStepAssessment,
  WorkflowStepContract
} from "./types.js"
