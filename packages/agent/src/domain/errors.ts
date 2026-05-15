/** Domain error types for governance control flow. */

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
    public readonly target: string,
  ) {
    super(`${entity}: cannot transition from '${current}' to '${target}'`)
    this.name = "InvalidTransitionError"
  }
}

export class PolicyViolationError extends DomainError {
  constructor(
    public readonly policyName: string,
    public readonly reason: string,
  ) {
    super(`Policy '${policyName}' violated: ${reason}`)
    this.name = "PolicyViolationError"
  }
}
