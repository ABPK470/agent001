/**
 * DI container — wires the entire object graph.
 *
 * Single entry point for all dependencies. Replace adapters here
 * to switch infrastructure (e.g. MemoryRunRepository → PostgresRunRepository).
 */

import { builtinActions } from "../actions/builtin.js"
import { MemoryEventBus } from "../adapters/memory-event-bus.js"
import { MemoryQueue } from "../adapters/memory-queue.js"
import {
    MemoryApprovalRepository,
    MemoryAuditRepository,
    MemoryExecutionRecordRepository,
    MemoryRunRepository,
    MemoryWorkflowRepository,
} from "../adapters/memory-repositories.js"
import { ActionRegistry, StepExecutor } from "../engine/executor.js"
import { Learner } from "../engine/learner.js"
import { Orchestrator } from "../engine/orchestrator.js"
import { ApprovalService } from "../governance/approval-service.js"
import { AuditService } from "../governance/audit-service.js"
import { RulePolicyEvaluator } from "../governance/policy-engine.js"

export class Container {
  // Adapters
  readonly workflowRepo = new MemoryWorkflowRepository()
  readonly runRepo = new MemoryRunRepository()
  readonly approvalRepo = new MemoryApprovalRepository()
  readonly auditRepo = new MemoryAuditRepository()
  readonly recordRepo = new MemoryExecutionRecordRepository()
  readonly eventBus = new MemoryEventBus()
  readonly queue = new MemoryQueue()

  // Engine
  readonly actionRegistry = new ActionRegistry()
  readonly executor = new StepExecutor(this.actionRegistry)
  readonly learner = new Learner(this.recordRepo)
  readonly policyEvaluator = new RulePolicyEvaluator()

  readonly orchestrator = new Orchestrator({
    executor: this.executor,
    policyEvaluator: this.policyEvaluator,
    learner: this.learner,
    runRepo: this.runRepo,
    approvalRepo: this.approvalRepo,
    eventBus: this.eventBus,
  })

  // Governance
  readonly approvalService = new ApprovalService(
    this.approvalRepo,
    this.eventBus,
  )
  readonly auditService = new AuditService(this.auditRepo)

  constructor() {
    // Register built-in action handlers
    for (const handler of builtinActions()) {
      this.actionRegistry.register(handler)
    }
  }
}

let _container: Container | null = null

export function getContainer(): Container {
  if (!_container) {
    _container = new Container()
  }
  return _container
}

/** Reset for testing. */
export function resetContainer(): void {
  _container = null
}
