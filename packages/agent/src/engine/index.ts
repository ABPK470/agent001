/**
 * Engine barrel — governance infrastructure for the agent.
 *
 * This replaces the old @agent001/engine package. Only the parts
 * actually used by the agent and server are kept:
 *   - Run/step state machines with guarded transitions
 *   - Domain events for real-time broadcasting
 *   - Policy engine for tool access control
 *   - Audit service for immutable action logging
 *   - Learner for execution metrics
 *   - In-memory adapters (fresh per run)
 */

// Enums
export { PolicyEffect, RunStatus, StepStatus } from "./enums.js"

// Errors
export { DomainError, InvalidTransitionError, PolicyViolationError } from "./errors.js"

// Models
export {
    cancelRun,
    completeRun,
    completeStep,
    createAuditEntry,
    createRun,
    failRun,
    failStep,
    startPlanning,
    startRunning,
    startStep,
    type AgentRun,
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
    RunRepository
} from "./interfaces.js"

// Services
export { AuditService } from "./audit.js"
export { Learner, type OperationStats } from "./learner.js"
export { RulePolicyEvaluator } from "./policy.js"
export {
    getPolicyContext,
    runWithPolicyContext,
    type HostedPolicyContext,
    type PolicyRole,
    type PolicyRunMode,
} from "./policy-context.js"
export {
    extractToolFacts,
    matchesSelectorRule,
    resolveSelectorRules,
    type PolicyDbEnvironment,
    type PolicyDbOperation,
    type PolicyScope,
    type PolicySelectors,
    type SelectorResolution,
    type SelectorRuleParameters,
    type ToolFacts,
} from "./policy-selectors.js"

// In-memory adapters
export {
    MemoryAuditRepository,
    MemoryEventBus,
    MemoryExecutionRecordRepository,
    MemoryRunRepository
} from "./memory.js"

