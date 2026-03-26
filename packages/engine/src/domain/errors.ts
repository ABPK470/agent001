export class DomainError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DomainError"
  }
}

export class WorkflowNotFoundError extends DomainError {
  constructor(public readonly workflowId: string) {
    super(`Workflow '${workflowId}' not found`)
    this.name = "WorkflowNotFoundError"
  }
}

export class RunNotFoundError extends DomainError {
  constructor(public readonly runId: string) {
    super(`Run '${runId}' not found`)
    this.name = "RunNotFoundError"
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

export class ConnectorError extends DomainError {
  constructor(
    public readonly connectorName: string,
    public readonly detail: string,
  ) {
    super(`Connector '${connectorName}': ${detail}`)
    this.name = "ConnectorError"
  }
}

export class ApprovalRequiredError extends DomainError {
  constructor(
    public readonly approvalId: string,
    public readonly reason: string,
  ) {
    super(`Approval required (${approvalId}): ${reason}`)
    this.name = "ApprovalRequiredError"
  }
}

export class ExpressionError extends DomainError {
  constructor(
    public readonly expression: string,
    detail: string,
  ) {
    super(`Expression '${expression}': ${detail}`)
    this.name = "ExpressionError"
  }
}

export class ActionNotFoundError extends DomainError {
  constructor(public readonly actionName: string) {
    super(`Action handler '${actionName}' not registered`)
    this.name = "ActionNotFoundError"
  }
}
