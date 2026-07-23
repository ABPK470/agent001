/**
 * Domain — vocabulary only: enums and types.
 *
 * What: shared words and shapes for the agent package.
 * Why: one meaning for core, runtime, tools, and the platform.
 * Next: pure decisions live in `core/`; port-backed services in `ports/services/`.
 */

export * from "./enums/index.js"

export {
  ApprovalRequiredError,
  DomainError,
  InvalidTransitionError,
  PolicyViolationError
} from "./types/errors.js"

export {
  addStepToRunPure,
  cancelRun,
  cancelRunPure,
  completeRun,
  completeRunPure,
  completeStep,
  completeStepPure,
  createAuditEntry,
  createRun,
  failRun,
  failRunPure,
  blockStep,
  failStep,
  replaceStepInRunPure,
  startPlanning,
  startPlanningPure,
  startRunning,
  startRunningPure,
  startStep,
  startStepPure,
  type AgentRun,
  type AuditEntry,
  type ExecutionRecord,
  type PolicyRule,
  type Step
} from "./types/run-models.js"

export {
  approvalRequired,
  runCompleted,
  runFailed,
  runStarted,
  stepCompleted,
  stepFailed,
  stepStarted,
  type ApprovalRequired,
  type DomainEvent
} from "./types/events.js"

export type {
  AuditRepository,
  EventBus,
  ExecutionRecordRepository,
  PolicyEvaluator,
  RunRepository,
  Unsubscribe
} from "./types/interfaces.js"

export type { HostedPolicyContext } from "./types/policy-context.js"

export * from "./types/agent-constants.js"
export * from "./types/agent-types.js"
export * from "./types/branded-ids.js"
