/**
 * Core domain models — runtime state for agent runs and tool steps.
 *
 * Pure data + guarded state transitions. No infrastructure deps.
 */

import { randomUUID } from "node:crypto"
import { RunStatus, StepStatus } from "./enums.js"
import { InvalidTransitionError } from "./errors.js"

// ── Step (runtime) ───────────────────────────────────────────────

export interface Step {
  id: string
  definitionId: string
  name: string
  action: string
  input: Record<string, unknown>
  condition: string | null
  onError: "fail" | "skip" | "continue"
  status: StepStatus
  order: number
  output: Record<string, unknown>
  error: string | null
  startedAt: Date | null
  completedAt: Date | null
}

const STEP_TRANSITIONS: Record<string, Set<string>> = {
  [StepStatus.Pending]: new Set([StepStatus.Running, StepStatus.Skipped, StepStatus.Blocked]),
  [StepStatus.Running]: new Set([StepStatus.Completed, StepStatus.Failed, StepStatus.Blocked, StepStatus.Skipped]),
  [StepStatus.Blocked]: new Set([StepStatus.Running, StepStatus.Skipped]),
  [StepStatus.Failed]: new Set([StepStatus.Running]),
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

export function completeStep(step: Step, output?: Record<string, unknown>): void {
  transitionStep(step, StepStatus.Completed)
  step.output = output ?? {}
  step.completedAt = new Date()
}

export function failStep(step: Step, error: string): void {
  transitionStep(step, StepStatus.Failed)
  step.error = error
  step.completedAt = new Date()
}

// ── AgentRun ─────────────────────────────────────────────────────

export interface AgentRun {
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
  [RunStatus.Running]: new Set([RunStatus.WaitingForApproval, RunStatus.Completed, RunStatus.Failed, RunStatus.Cancelled]),
  [RunStatus.WaitingForApproval]: new Set([RunStatus.Running, RunStatus.Cancelled]),
}

function transitionRun(run: AgentRun, target: RunStatus): void {
  const allowed = RUN_TRANSITIONS[run.status]
  if (!allowed?.has(target)) {
    throw new InvalidTransitionError("Run", run.status, target)
  }
  run.status = target
}

export function createRun(workflowId: string, input: Record<string, unknown> = {}): AgentRun {
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

export function startPlanning(run: AgentRun): void {
  transitionRun(run, RunStatus.Planning)
}

export function startRunning(run: AgentRun, steps: Step[]): void {
  run.steps = steps
  transitionRun(run, RunStatus.Running)
}

export function completeRun(run: AgentRun): void {
  transitionRun(run, RunStatus.Completed)
  run.completedAt = new Date()
}

export function failRun(run: AgentRun): void {
  transitionRun(run, RunStatus.Failed)
  run.completedAt = new Date()
}

// ── Policy Rule ──────────────────────────────────────────────────

export interface PolicyRule {
  name: string
  effect: PolicyEffect
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

// Re-export PolicyEffect for convenience — used in PolicyRule
import { PolicyEffect } from "./enums.js"
