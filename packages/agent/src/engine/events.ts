/** Domain events emitted during agent runs and tool execution. */

import { randomUUID } from "node:crypto";

export interface DomainEvent {
  readonly eventId: string
  readonly type: string
  readonly occurredAt: Date
}

function base<T extends string>(type: T): { eventId: string; type: T; occurredAt: Date } {
  return { eventId: randomUUID(), type, occurredAt: new Date() }
}

// ── Run events ───────────────────────────────────────────────────

export interface RunStarted extends DomainEvent { type: "run.started"; runId: string; workflowId: string }
export function runStarted(runId: string, workflowId: string): RunStarted {
  return { ...base("run.started"), runId, workflowId }
}

export interface RunCompleted extends DomainEvent { type: "run.completed"; runId: string }
export function runCompleted(runId: string): RunCompleted {
  return { ...base("run.completed"), runId }
}

export interface RunFailed extends DomainEvent { type: "run.failed"; runId: string; reason: string }
export function runFailed(runId: string, reason: string): RunFailed {
  return { ...base("run.failed"), runId, reason }
}

// ── Step events ──────────────────────────────────────────────────

export interface StepStarted extends DomainEvent { type: "step.started"; runId: string; stepId: string }
export function stepStarted(runId: string, stepId: string): StepStarted {
  return { ...base("step.started"), runId, stepId }
}

export interface StepCompleted extends DomainEvent { type: "step.completed"; runId: string; stepId: string }
export function stepCompleted(runId: string, stepId: string): StepCompleted {
  return { ...base("step.completed"), runId, stepId }
}

export interface StepFailed extends DomainEvent { type: "step.failed"; runId: string; stepId: string; reason: string }
export function stepFailed(runId: string, stepId: string, reason: string): StepFailed {
  return { ...base("step.failed"), runId, stepId, reason }
}
