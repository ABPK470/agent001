import type { SyncPlan } from "../../types"

export interface ExecPreflightCheck {
  id: string
  label: string
  passed: boolean
  detail: string | null
}

export function buildExecPreflightChecks(plan: SyncPlan): ExecPreflightCheck[] {
  const hasChanges =
    plan.totals.insert + plan.totals.update + plan.totals.delete > 0
  const conflictCount = plan.totals.conflicts ?? 0

  return [
    {
      id: "catalog",
      label: "Catalog compatible (source vs target schema)",
      passed: plan.preflight.catalogCompatible,
      detail: plan.preflight.issues[0] ?? null
    },
    {
      id: "root-parent",
      label: "Root parent ready on target",
      passed: plan.preflight.rootParentReady !== false,
      detail: plan.preflight.rootParentIssue
    },
    {
      id: "conflicts",
      label: "No scope conflicts",
      passed: conflictCount === 0,
      detail: conflictCount > 0 ? `${conflictCount} conflict(s) in plan` : null
    },
    {
      id: "changes",
      label: "Plan has changes to apply",
      passed: hasChanges,
      detail: hasChanges ? null : "No inserts, updates, or deletes"
    }
  ]
}

export function execPreflightBlocked(plan: SyncPlan): boolean {
  return buildExecPreflightChecks(plan).some((check) => !check.passed)
}

export function execPreflightBlockReason(plan: SyncPlan): string | null {
  const failed = buildExecPreflightChecks(plan).filter((check) => !check.passed)
  if (failed.length === 0) return null
  return failed.map((check) => check.detail ?? check.label).join("; ")
}
