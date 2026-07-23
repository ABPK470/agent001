/** Domain error types for governance control flow. */

import type { RunId, StepId } from "./branded-ids.js"

export class DomainError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DomainError"
  }
}

export class InvalidTransitionError extends DomainError {
  constructor(
    public readonly entity: string,
    public readonly current: string,
    public readonly target: string
  ) {
    super(`${entity}: cannot transition from '${current}' to '${target}'`)
    this.name = "InvalidTransitionError"
  }
}

export class PolicyViolationError extends DomainError {
  constructor(
    public readonly policyName: string,
    public readonly reason: string
  ) {
    super(`Policy '${policyName}' violated: ${reason}`)
    this.name = "PolicyViolationError"
  }
}

/** Tool blocked pending operator approval — run should pause, not fail. */
export class ApprovalRequiredError extends DomainError {
  constructor(
    public readonly runId: RunId,
    public readonly stepId: StepId,
    public readonly toolName: string,
    public readonly args: Record<string, unknown>,
    public readonly reason: string,
    public readonly policyName: string
  ) {
    super(`Approval required for tool "${toolName}": ${reason}`)
    this.name = "ApprovalRequiredError"
  }
}
