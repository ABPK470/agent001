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
} from "./models/errors.js"

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
} from "./models/run-models.js"

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
} from "./models/interfaces.js"

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
} from "./models/memory.js"

export * from "./models/agent-constants.js"
export * from "./models/agent-types.js"
