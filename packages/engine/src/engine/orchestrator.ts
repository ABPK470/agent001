/**
 * Orchestrator — generic workflow execution engine.
 *
 *   plan  →  for each ready step:
 *              evaluate condition  →  resolve expressions  →
 *              evaluate policies   →  execute action        →
 *              record result       →  check next steps
 *
 * The orchestrator knows nothing about specific business logic.
 * It interprets WorkflowDefinitions, resolves expressions, dispatches
 * to registered action handlers, and enforces governance policies.
 *
 * This is the core of the platform — it can execute ANY workflow.
 */

import { StepStatus } from "../domain/enums.js"
import { ApprovalRequiredError } from "../domain/errors.js"
import {
    approvalRequested,
    runCompleted,
    runFailed,
    runStarted,
    stepCompleted,
    stepFailed,
    stepStarted,
} from "../domain/events.js"
import {
    type Workflow,
    type WorkflowRun,
    blockStep,
    completeRun,
    completeStep,
    createApprovalRequest,
    createRun,
    failRun,
    failStep,
    resumeRun,
    skipStep,
    startPlanning,
    startRunning,
    startStep,
    waitForApproval,
} from "../domain/models.js"
import type {
    ApprovalRepository,
    RunRepository,
} from "../ports/repositories.js"
import type { EventBus, PolicyEvaluator } from "../ports/services.js"
import type { StepExecutor } from "./executor.js"
import {
    buildContext,
    evaluateCondition,
    resolveExpressions,
} from "./expression.js"
import type { Learner } from "./learner.js"
import { planSteps } from "./planner.js"

export interface OrchestratorDeps {
  executor: StepExecutor
  policyEvaluator: PolicyEvaluator
  learner: Learner
  runRepo: RunRepository
  approvalRepo: ApprovalRepository
  eventBus: EventBus
}

export class Orchestrator {
  private readonly executor: StepExecutor
  private readonly policy: PolicyEvaluator
  private readonly learner: Learner
  private readonly runs: RunRepository
  private readonly approvals: ApprovalRepository
  private readonly bus: EventBus

  constructor(deps: OrchestratorDeps) {
    this.executor = deps.executor
    this.policy = deps.policyEvaluator
    this.learner = deps.learner
    this.runs = deps.runRepo
    this.approvals = deps.approvalRepo
    this.bus = deps.eventBus
  }

  // ── public API ────────────────────────────────────────────────

  async startRun(
    workflow: Workflow,
    input: Record<string, unknown> = {},
  ): Promise<WorkflowRun> {
    const run = createRun(workflow.id, input)

    // 1. Plan
    startPlanning(run)
    await this.runs.save(run)
    const steps = planSteps(workflow, input)
    startRunning(run, steps)
    await this.runs.save(run)
    await this.bus.publish(runStarted(run.id, workflow.id))

    // 2. Execute
    await this.executeSteps(run)
    return run
  }

  async resume(run: WorkflowRun): Promise<WorkflowRun> {
    resumeRun(run)
    await this.runs.save(run)
    await this.executeSteps(run)
    return run
  }

  // ── generic execution loop ────────────────────────────────────

  private async executeSteps(run: WorkflowRun): Promise<void> {
    const ctx = buildContext(run)

    for (const step of run.steps) {
      if (
        step.status === StepStatus.Completed ||
        step.status === StepStatus.Skipped
      ) {
        continue
      }

      // Condition check — skip if falsy
      if (step.condition) {
        if (!evaluateCondition(step.condition, ctx)) {
          skipStep(step)
          continue
        }
      }

      // Resolve expressions in step input
      const resolvedInput = resolveExpressions(step.input, ctx) as Record<
        string,
        unknown
      >

      // Policy check
      const reason = await this.policy.evaluatePreStep(run, step)
      if (reason !== null) {
        blockStep(step)
        waitForApproval(run)
        const approval = createApprovalRequest({
          runId: run.id,
          stepId: step.id,
          reason,
          policyName: "pre-step-policy",
        })
        await this.approvals.save(approval)
        await this.runs.save(run)
        await this.bus.publish(
          approvalRequested(approval.id, run.id, step.id, reason),
        )
        throw new ApprovalRequiredError(approval.id, reason)
      }

      // Execute
      startStep(step)
      await this.bus.publish(stepStarted(run.id, step.id))

      const record = await this.executor.executeAndRecord(
        step.action,
        resolvedInput,
        { runId: run.id, stepId: step.id },
      )
      await this.learner.record(record)

      if (record.success) {
        completeStep(step, record.result)
        // Update context so subsequent steps see this output
        ctx.steps[step.definitionId] = {
          output: step.output,
          status: step.status,
        }
        await this.bus.publish(stepCompleted(run.id, step.id))
      } else {
        const errorMsg = record.error ?? "unknown error"
        const errorStrategy = step.onError

        if (errorStrategy === "skip") {
          skipStep(step)
          ctx.steps[step.definitionId] = { output: {}, status: step.status }
          continue
        }

        if (errorStrategy === "continue") {
          failStep(step, errorMsg)
          ctx.steps[step.definitionId] = { output: {}, status: step.status }
          await this.bus.publish(stepFailed(run.id, step.id, errorMsg))
          continue
        }

        // Default: fail the run
        failStep(step, errorMsg)
        failRun(run)
        await this.runs.save(run)
        await this.bus.publish(stepFailed(run.id, step.id, errorMsg))
        await this.bus.publish(runFailed(run.id, errorMsg))
        return
      }
    }

    // All steps done
    completeRun(run)
    await this.runs.save(run)
    await this.bus.publish(runCompleted(run.id))
  }
}
