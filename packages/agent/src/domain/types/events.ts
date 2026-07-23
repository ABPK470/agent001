/** Domain events emitted during agent runs and tool execution. */

import { randomUUID } from "node:crypto"
import { EventType } from "../enums/event.js"
import type { RunId, StepId } from "./branded-ids.js"

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
  runId: RunId
  workflowId: string
}
export function runStarted(runId: RunId, workflowId: string): RunStarted {
  return { ...base(EventType.RunStarted), runId, workflowId }
}

export interface RunCompleted extends DomainEvent {
  type: typeof EventType.RunCompleted
  runId: RunId
}
export function runCompleted(runId: RunId): RunCompleted {
  return { ...base(EventType.RunCompleted), runId }
}

export interface RunFailed extends DomainEvent {
  type: typeof EventType.RunFailed
  runId: RunId
  reason: string
}
export function runFailed(runId: RunId, reason: string): RunFailed {
  return { ...base(EventType.RunFailed), runId, reason }
}

// ── Step events ──────────────────────────────────────────────────

export interface StepStarted extends DomainEvent {
  type: typeof EventType.StepStarted
  runId: RunId
  stepId: StepId
}
export function stepStarted(runId: RunId, stepId: StepId): StepStarted {
  return { ...base(EventType.StepStarted), runId, stepId }
}

export interface StepCompleted extends DomainEvent {
  type: typeof EventType.StepCompleted
  runId: RunId
  stepId: StepId
}
export function stepCompleted(runId: RunId, stepId: StepId): StepCompleted {
  return { ...base(EventType.StepCompleted), runId, stepId }
}

export interface StepFailed extends DomainEvent {
  type: typeof EventType.StepFailed
  runId: RunId
  stepId: StepId
  reason: string
}
export function stepFailed(runId: RunId, stepId: StepId, reason: string): StepFailed {
  return { ...base(EventType.StepFailed), runId, stepId, reason }
}

// ── Approval events ──────────────────────────────────────────────

export interface ApprovalRequired extends DomainEvent {
  type: typeof EventType.ApprovalRequired
  runId: RunId
  stepId: StepId
  toolName: string
  args: Record<string, unknown>
  reason: string
}
export function approvalRequired(
  runId: RunId,
  stepId: StepId,
  toolName: string,
  args: Record<string, unknown>,
  reason: string
): ApprovalRequired {
  return { ...base(EventType.ApprovalRequired), runId, stepId, toolName, args, reason }
}
