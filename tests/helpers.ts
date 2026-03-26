/**
 * Shared test helpers.
 */

import { randomUUID } from "node:crypto"
import { MemoryEventBus } from "../src/adapters/memory-event-bus.js"
import {
    MemoryApprovalRepository,
    MemoryAuditRepository,
    MemoryExecutionRecordRepository,
    MemoryRunRepository,
    MemoryWorkflowRepository,
} from "../src/adapters/memory-repositories.js"
import { WorkflowStatus } from "../src/domain/enums.js"
import type { Workflow } from "../src/domain/models.js"
import type { WorkflowDefinition } from "../src/domain/workflow-schema.js"
import type { ActionHandler, ExecutionContext } from "../src/engine/executor.js"
import { ActionRegistry, StepExecutor } from "../src/engine/executor.js"
import { Learner } from "../src/engine/learner.js"
import { Orchestrator } from "../src/engine/orchestrator.js"
import { RulePolicyEvaluator } from "../src/governance/policy-engine.js"

// ── Fake action handlers ─────────────────────────────────────────

export class FakeAction implements ActionHandler {
  readonly name: string
  calls: Array<{ input: Record<string, unknown>; ctx: ExecutionContext }> = []
  private result: Record<string, unknown>

  constructor(name = "fake", result: Record<string, unknown> = { ok: true }) {
    this.name = name
    this.result = result
  }

  async execute(
    input: Record<string, unknown>,
    ctx: ExecutionContext,
  ): Promise<Record<string, unknown>> {
    this.calls.push({ input, ctx })
    return { ...this.result }
  }
}

export class FailingAction implements ActionHandler {
  readonly name: string
  constructor(name = "failing") {
    this.name = name
  }
  async execute(): Promise<Record<string, unknown>> {
    throw new Error("boom")
  }
}

// ── Test fixture builder ─────────────────────────────────────────

export function buildTestDeps() {
  const workflowRepo = new MemoryWorkflowRepository()
  const runRepo = new MemoryRunRepository()
  const approvalRepo = new MemoryApprovalRepository()
  const auditRepo = new MemoryAuditRepository()
  const recordRepo = new MemoryExecutionRecordRepository()
  const eventBus = new MemoryEventBus()
  const actionRegistry = new ActionRegistry()
  const executor = new StepExecutor(actionRegistry)
  const learner = new Learner(recordRepo)
  const policyEvaluator = new RulePolicyEvaluator()

  const orchestrator = new Orchestrator({
    executor,
    policyEvaluator,
    learner,
    runRepo,
    approvalRepo,
    eventBus,
  })

  return {
    workflowRepo,
    runRepo,
    approvalRepo,
    auditRepo,
    recordRepo,
    eventBus,
    actionRegistry,
    executor,
    learner,
    policyEvaluator,
    orchestrator,
  }
}

/** Create a minimal workflow for testing. */
export function makeWorkflow(
  overrides?: Partial<WorkflowDefinition>,
): Workflow {
  const definition: WorkflowDefinition = {
    name: "Test Workflow",
    description: "A test workflow",
    inputSchema: {},
    steps: [
      {
        id: "step1",
        name: "Step 1",
        action: "fake",
        input: {},
      },
    ],
    ...overrides,
  }

  return {
    id: randomUUID(),
    status: WorkflowStatus.Active,
    definition,
    createdAt: new Date(),
  }
}
