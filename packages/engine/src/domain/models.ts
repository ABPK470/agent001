/**
 * Core domain entities — runtime state for workflows, runs, steps.
 *
 * Pure data + guarded state transitions. No infrastructure deps.
 */

import { randomUUID } from "node:crypto"
import {
    ApprovalStatus,
    PolicyEffect,
    RunStatus,
    StepStatus,
    WorkflowStatus,
} from "./enums.js"
import { InvalidTransitionError } from "./errors.js"
import type { WorkflowDefinition } from "./workflow-schema.js"

// ── Workflow ─────────────────────────────────────────────────────

export interface Workflow {
  id: string
  status: WorkflowStatus
  definition: WorkflowDefinition
  createdAt: Date
}

export function createWorkflow(definition: WorkflowDefinition): Workflow {
  return {
    id: randomUUID(),
    status: WorkflowStatus.Draft,
    definition,
    createdAt: new Date(),
  }
}

export function activateWorkflow(wf: Workflow): void {
  if (
    wf.status !== WorkflowStatus.Draft &&
    wf.status !== WorkflowStatus.Archived
  ) {
    throw new InvalidTransitionError(
      "Workflow",
      wf.status,
      WorkflowStatus.Active,
    )
  }
  wf.status = WorkflowStatus.Active
}

export function archiveWorkflow(wf: Workflow): void {
  if (wf.status !== WorkflowStatus.Active) {
    throw new InvalidTransitionError(
      "Workflow",
      wf.status,
      WorkflowStatus.Archived,
    )
  }
  wf.status = WorkflowStatus.Archived
}

// ── Step (runtime) ───────────────────────────────────────────────

export interface Step {
  id: string
  /** References StepDefinition.id from the workflow definition. */
  definitionId: string
  name: string
  action: string
  input: Record<string, unknown>
  /** Condition expression — if falsy the step is skipped. */
  condition: string | null
  /** Error strategy from the workflow definition. */
  onError: "fail" | "skip" | "continue"
  status: StepStatus
  order: number
  output: Record<string, unknown>
  error: string | null
  startedAt: Date | null
  completedAt: Date | null
}

const STEP_TRANSITIONS: Record<string, Set<string>> = {
  [StepStatus.Pending]: new Set([
    StepStatus.Running,
    StepStatus.Skipped,
    StepStatus.Blocked,
  ]),
  [StepStatus.Running]: new Set([
    StepStatus.Completed,
    StepStatus.Failed,
    StepStatus.Blocked,
    StepStatus.Skipped,
  ]),
  [StepStatus.Blocked]: new Set([StepStatus.Running, StepStatus.Skipped]),
  [StepStatus.Failed]: new Set([StepStatus.Running]), // retry
}

function transitionStep(step: Step, target: StepStatus): void {
  const allowed = STEP_TRANSITIONS[step.status]
  if (!allowed?.has(target)) {
    throw new InvalidTransitionError("Step", step.status, target)
  }
  step.status = target
}

export function startStep(step: Step): void {
  transitionStep(step, StepStatus.Running)
  step.startedAt = new Date()
}

export function completeStep(
  step: Step,
  output?: Record<string, unknown>,
): void {
  transitionStep(step, StepStatus.Completed)
  step.output = output ?? {}
  step.completedAt = new Date()
}

export function failStep(step: Step, error: string): void {
  transitionStep(step, StepStatus.Failed)
  step.error = error
  step.completedAt = new Date()
}

export function blockStep(step: Step): void {
  transitionStep(step, StepStatus.Blocked)
}

export function skipStep(step: Step): void {
  transitionStep(step, StepStatus.Skipped)
}

// ── WorkflowRun ──────────────────────────────────────────────────

export interface WorkflowRun {
  id: string
  workflowId: string
  input: Record<string, unknown>
  status: RunStatus
  steps: Step[]
  createdAt: Date
  completedAt: Date | null
}

const RUN_TRANSITIONS: Record<string, Set<string>> = {
  [RunStatus.Pending]: new Set([RunStatus.Planning]),
  [RunStatus.Planning]: new Set([RunStatus.Running, RunStatus.Failed]),
  [RunStatus.Running]: new Set([
    RunStatus.WaitingForApproval,
    RunStatus.Completed,
    RunStatus.Failed,
    RunStatus.Cancelled,
  ]),
  [RunStatus.WaitingForApproval]: new Set([
    RunStatus.Running,
    RunStatus.Cancelled,
  ]),
}

function transitionRun(run: WorkflowRun, target: RunStatus): void {
  const allowed = RUN_TRANSITIONS[run.status]
  if (!allowed?.has(target)) {
    throw new InvalidTransitionError("Run", run.status, target)
  }
  run.status = target
}

export function createRun(
  workflowId: string,
  input: Record<string, unknown> = {},
): WorkflowRun {
  return {
    id: randomUUID(),
    workflowId,
    input,
    status: RunStatus.Pending,
    steps: [],
    createdAt: new Date(),
    completedAt: null,
  }
}

export function startPlanning(run: WorkflowRun): void {
  transitionRun(run, RunStatus.Planning)
}

export function startRunning(run: WorkflowRun, steps: Step[]): void {
  run.steps = steps
  transitionRun(run, RunStatus.Running)
}

export function waitForApproval(run: WorkflowRun): void {
  transitionRun(run, RunStatus.WaitingForApproval)
}

export function resumeRun(run: WorkflowRun): void {
  transitionRun(run, RunStatus.Running)
}

export function completeRun(run: WorkflowRun): void {
  transitionRun(run, RunStatus.Completed)
  run.completedAt = new Date()
}

export function failRun(run: WorkflowRun): void {
  transitionRun(run, RunStatus.Failed)
  run.completedAt = new Date()
}

export function cancelRun(run: WorkflowRun): void {
  transitionRun(run, RunStatus.Cancelled)
  run.completedAt = new Date()
}

export function currentStep(run: WorkflowRun): Step | undefined {
  return run.steps.find(
    (s) =>
      s.status === StepStatus.Pending ||
      s.status === StepStatus.Running ||
      s.status === StepStatus.Blocked,
  )
}

// ── ApprovalRequest ──────────────────────────────────────────────

export interface ApprovalRequest {
  id: string
  runId: string
  stepId: string
  reason: string
  policyName: string
  context: Record<string, unknown>
  status: ApprovalStatus
  resolvedBy: string | null
  resolvedAt: Date | null
  createdAt: Date
}

export function createApprovalRequest(params: {
  runId: string
  stepId: string
  reason: string
  policyName: string
  context?: Record<string, unknown>
}): ApprovalRequest {
  return {
    id: randomUUID(),
    runId: params.runId,
    stepId: params.stepId,
    reason: params.reason,
    policyName: params.policyName,
    context: params.context ?? {},
    status: ApprovalStatus.Pending,
    resolvedBy: null,
    resolvedAt: null,
    createdAt: new Date(),
  }
}

export function approveRequest(req: ApprovalRequest, user: string): void {
  if (req.status !== ApprovalStatus.Pending) {
    throw new InvalidTransitionError(
      "ApprovalRequest",
      req.status,
      ApprovalStatus.Approved,
    )
  }
  req.status = ApprovalStatus.Approved
  req.resolvedBy = user
  req.resolvedAt = new Date()
}

export function rejectRequest(req: ApprovalRequest, user: string): void {
  if (req.status !== ApprovalStatus.Pending) {
    throw new InvalidTransitionError(
      "ApprovalRequest",
      req.status,
      ApprovalStatus.Rejected,
    )
  }
  req.status = ApprovalStatus.Rejected
  req.resolvedBy = user
  req.resolvedAt = new Date()
}

// ── Policy Rule ──────────────────────────────────────────────────

export interface PolicyRule {
  name: string
  effect: PolicyEffect
  /** Expression or condition key, e.g. "amount_gt:1000", "action:http.request" */
  condition: string
  parameters: Record<string, unknown>
}

// ── Audit Entry ──────────────────────────────────────────────────

export interface AuditEntry {
  id: string
  actor: string
  action: string
  resourceType: string
  resourceId: string
  detail: Record<string, unknown>
  timestamp: Date
}

export function createAuditEntry(params: {
  actor: string
  action: string
  resourceType: string
  resourceId: string
  detail?: Record<string, unknown>
}): AuditEntry {
  return {
    id: randomUUID(),
    actor: params.actor,
    action: params.action,
    resourceType: params.resourceType,
    resourceId: params.resourceId,
    detail: params.detail ?? {},
    timestamp: new Date(),
  }
}

// ── Execution Record (learning) ──────────────────────────────────

export interface ExecutionRecord {
  id: string
  runId: string
  stepId: string
  action: string
  success: boolean
  durationMs: number
  result: Record<string, unknown>
  error: string | null
  recordedAt: Date
}
