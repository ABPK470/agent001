/**
 * Domain — shared words, shapes, and domain services.
 *
 * What: enums, models, policy/audit/learner/events.
 * Why: one vocabulary for core, runtime, tools, and the platform.
 * Next: import from here (or `@mia/agent`); do not invent parallel types.
 *
 * Honesty: this is not “vocabulary only.” `services/` holds real domain
 * services (policy evaluation, audit, learner, event helpers).
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
} from "./services/events.js"

export type {
  AuditRepository,
  EventBus,
  ExecutionRecordRepository,
  PolicyEvaluator,
  RunRepository,
  Unsubscribe
} from "./types/interfaces.js"

export { AuditService } from "./services/audit.js"
export { Learner, type OperationStats } from "./services/learner.js"
export { type HostedPolicyContext } from "./services/policy-context.js"
export {
  extractToolFacts,
  matchesSelectorRule,
  resolveSelectorRules,
  type PolicySelectors,
  type SelectorResolution,
  type SelectorRuleParameters,
  type ToolFacts
} from "./services/policy-selectors.js"
export { RulePolicyEvaluator } from "./services/policy.js"

export {
  MemoryAuditRepository,
  MemoryEventBus,
  MemoryExecutionRecordRepository,
  MemoryRunRepository
} from "./types/memory.js"

export * from "./types/agent-constants.js"
export * from "./types/agent-types.js"
