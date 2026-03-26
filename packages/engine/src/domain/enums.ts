// ── Workflow lifecycle ────────────────────────────────────────────

export enum WorkflowStatus {
  Draft = "draft",
  Active = "active",
  Archived = "archived",
}

// ── Run lifecycle ────────────────────────────────────────────────

export enum RunStatus {
  Pending = "pending",
  Planning = "planning",
  Running = "running",
  WaitingForApproval = "waiting_for_approval",
  Completed = "completed",
  Failed = "failed",
  Cancelled = "cancelled",
}

// ── Step lifecycle ───────────────────────────────────────────────

export enum StepStatus {
  Pending = "pending",
  Running = "running",
  Completed = "completed",
  Failed = "failed",
  Skipped = "skipped",
  Blocked = "blocked",
}

// ── Governance ───────────────────────────────────────────────────

export enum ApprovalStatus {
  Pending = "pending",
  Approved = "approved",
  Rejected = "rejected",
  Expired = "expired",
}

export enum PolicyEffect {
  Allow = "allow",
  RequireApproval = "require_approval",
  Deny = "deny",
}

export enum Severity {
  Info = "info",
  Warning = "warning",
  Error = "error",
  Critical = "critical",
}
