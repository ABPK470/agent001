/**
 * Service port interfaces — contracts the engine relies on.
 */

import type { DomainEvent } from "../domain/events.js"
import type { Step, WorkflowRun } from "../domain/models.js"

/** Evaluates governance policies against a step about to run. */
export interface PolicyEvaluator {
  /**
   * Return `null` if the step may proceed.
   * Return a reason string if approval is required.
   * Throw `PolicyViolationError` on hard deny.
   */
  evaluatePreStep(run: WorkflowRun, step: Step): Promise<string | null>
}

/** Async event bus for domain events. */
export interface EventBus {
  publish(event: DomainEvent): Promise<void>
  subscribe(
    eventType: string,
    handler: (event: DomainEvent) => Promise<void>,
  ): void
}

/**
 * Work queue — the scaling boundary.
 *
 * In single-process mode this is a no-op pass-through.
 * In scaled mode this is backed by Redis/RabbitMQ/SQS and
 * workers consume step execution jobs independently.
 */
export interface WorkQueue {
  enqueue(job: StepJob): Promise<void>
  /** Register a worker that processes jobs. */
  process(handler: (job: StepJob) => Promise<void>): void
}

export interface StepJob {
  runId: string
  stepId: string
  action: string
  input: Record<string, unknown>
}
