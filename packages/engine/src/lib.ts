/**
 * Library exports — everything other packages need from the engine.
 *
 * This is NOT the server entry point (that's index.ts).
 * This is the barrel export for using the engine as a library.
 */

// Domain
export {
    blockStep, completeRun,
    completeStep,
    createAuditEntry,
    createRun,
    failRun,
    failStep, skipStep, startPlanning,
    startRunning,
    startStep, type AuditEntry,
    type ExecutionRecord,
    type PolicyRule,
    type Step,
    type Workflow,
    type WorkflowRun
} from "./domain/models.js"

export {
    ApprovalStatus,
    PolicyEffect,
    RunStatus,
    StepStatus,
    WorkflowStatus
} from "./domain/enums.js"

export {
    runCompleted,
    runFailed,
    runStarted,
    stepCompleted,
    stepFailed,
    stepStarted, type DomainEvent
} from "./domain/events.js"

export {
    DomainError,
    PolicyViolationError
} from "./domain/errors.js"

// Ports
export type {
    AuditRepository,
    ExecutionRecordRepository,
    RunRepository
} from "./ports/repositories.js"

export type {
    EventBus,
    PolicyEvaluator
} from "./ports/services.js"

// Engine
export { Learner, type OperationStats } from "./engine/learner.js"

// Governance
export { AuditService } from "./governance/audit-service.js"
export { RulePolicyEvaluator } from "./governance/policy-engine.js"

// Adapters
export {
    MemoryAuditRepository,
    MemoryExecutionRecordRepository,
    MemoryRunRepository
} from "./adapters/memory-repositories.js"

export { MemoryEventBus } from "./adapters/memory-event-bus.js"
