/** Lifecycle enums for runs, steps, and governance. */

export enum RunStatus {
  Pending = "pending",
  Planning = "planning",
  Running = "running",
  WaitingForApproval = "waiting_for_approval",
  Completed = "completed",
  Failed = "failed",
  Cancelled = "cancelled",
}

export enum StepStatus {
  Pending = "pending",
  Running = "running",
  Completed = "completed",
  Failed = "failed",
  Skipped = "skipped",
  Blocked = "blocked",
}

export enum PolicyEffect {
  Allow = "allow",
  RequireApproval = "require_approval",
  Deny = "deny",
}
