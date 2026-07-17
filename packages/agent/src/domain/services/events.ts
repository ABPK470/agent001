/** Domain events emitted during agent runs and tool execution. */

import { randomUUID } from "node:crypto"
import { EventType } from "./enums/event.js"

export interface DomainEvent {
  readonly eventId: string
  readonly type: string
  readonly occurredAt: Date
}

function base<T extends string>(type: T): { eventId: string; type: T; occurredAt: Date } {
  return { eventId: randomUUID(), type, occurredAt: new Date() }
}

// ── Run events ───────────────────────────────────────────────────

export interface RunStarted extends DomainEvent {
  type: typeof EventType.RunStarted
  runId: string
  workflowId: string
}
export function runStarted(runId: string, workflowId: string): RunStarted {
  return { ...base(EventType.RunStarted), runId, workflowId }
}

export interface RunCompleted extends DomainEvent {
  type: typeof EventType.RunCompleted
  runId: string
}
export function runCompleted(runId: string): RunCompleted {
  return { ...base(EventType.RunCompleted), runId }
}

export interface RunFailed extends DomainEvent {
  type: typeof EventType.RunFailed
  runId: string
  reason: string
}
export function runFailed(runId: string, reason: string): RunFailed {
  return { ...base(EventType.RunFailed), runId, reason }
}

// ── Step events ──────────────────────────────────────────────────

export interface StepStarted extends DomainEvent {
  type: typeof EventType.StepStarted
  runId: string
  stepId: string
}
export function stepStarted(runId: string, stepId: string): StepStarted {
  return { ...base(EventType.StepStarted), runId, stepId }
}

export interface StepCompleted extends DomainEvent {
  type: typeof EventType.StepCompleted
  runId: string
  stepId: string
}
export function stepCompleted(runId: string, stepId: string): StepCompleted {
  return { ...base(EventType.StepCompleted), runId, stepId }
}

export interface StepFailed extends DomainEvent {
  type: typeof EventType.StepFailed
  runId: string
  stepId: string
  reason: string
}
export function stepFailed(runId: string, stepId: string, reason: string): StepFailed {
  return { ...base(EventType.StepFailed), runId, stepId, reason }
}

// ── Approval events ──────────────────────────────────────────────

export interface ApprovalRequired extends DomainEvent {
  type: typeof EventType.ApprovalRequired
  runId: string
  stepId: string
  toolName: string
  args: Record<string, unknown>
  reason: string
}
export function approvalRequired(
  runId: string,
  stepId: string,
  toolName: string,
  args: Record<string, unknown>,
  reason: string
): ApprovalRequired {
  return { ...base(EventType.ApprovalRequired), runId, stepId, toolName, args, reason }
}
