/**
 * Engine barrel — governance infrastructure for the agent.
 *
 * This replaces the old @mia/engine package. Only the parts
 * actually used by the agent and server are kept:
 *   - Run/step state machines with guarded transitions
 *   - Domain events for real-time broadcasting
 *   - Policy engine for tool access control
 *   - Audit service for immutable action logging
 *   - Learner for execution metrics
 *   - In-memory adapters (fresh per run)
 */

// Enums — every domain enum lives under `engine/enums/`. Re-export the
// whole barrel so adding a new domain enum doesn't require touching
// this file.
export * from "./enums/index.js"

// Errors
export { DomainError, InvalidTransitionError, PolicyViolationError } from "./errors.js"

// Models
export {
    addStepToRunPure, cancelRun, cancelRunPure, completeRun, completeRunPure, completeStep,
    completeStepPure,
    createAuditEntry,
    createRun,
    failRun, failRunPure, failStep, replaceStepInRunPure, startPlanning, startPlanningPure, startRunning, startRunningPure, startStep,
    startStepPure, type AgentRun,
    type AuditEntry,
    type ExecutionRecord,
    type PolicyRule,
    type Step
} from "./models.js"

// Events
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
} from "./events.js"

// Interfaces
export type {
    AuditRepository,
    EventBus,
    ExecutionRecordRepository,
    PolicyEvaluator,
    RunRepository,
    Unsubscribe
} from "./interfaces.js"

// Services
export { AuditService } from "./audit.js"
export { Learner, type OperationStats } from "./learner.js"
export {
    type HostedPolicyContext
} from "./policy-context.js"
export {
    extractToolFacts,
    matchesSelectorRule,
    resolveSelectorRules,
    type PolicySelectors,
    type SelectorResolution,
    type SelectorRuleParameters,
    type ToolFacts
} from "./policy-selectors.js"
export { RulePolicyEvaluator } from "./policy.js"

// In-memory adapters
export {
    MemoryAuditRepository,
    MemoryEventBus,
    MemoryExecutionRecordRepository,
    MemoryRunRepository
} from "./memory.js"

export * from "./agent-constants.js"
export * from "./agent-types.js"

