import type { SyncPlan } from "../../types"

export interface ExecPreflightCheck {
  id: string
  label: string
  passed: boolean
  detail: string | null
  /** When false, shown for transparency only — never blocks execute. */
  blocking?: boolean
}

export function planHasMetadataChanges(plan: SyncPlan): boolean {
  return plan.totals.insert + plan.totals.update + plan.totals.delete > 0
}

export function buildExecPreflightChecks(plan: SyncPlan): ExecPreflightCheck[] {
  const hasChanges = planHasMetadataChanges(plan)
  const conflictCount = plan.totals.conflicts ?? 0
  const { insert, update, delete: del, tablesCount } = plan.totals

  const targetWriteEnabled = plan.preflight.targetWriteEnabled
  const targetWritePassed = targetWriteEnabled !== false

  return [
    {
      id: "catalog",
      label: "Catalog compatible (source vs target schema)",
      passed: plan.preflight.catalogCompatible,
      detail: plan.preflight.issues[0] ?? null
    },
    {
      id: "target-write",
      label: "Target connector Write enabled",
      passed: targetWritePassed,
      detail:
        targetWriteEnabled === false
          ? (plan.preflight.targetWriteIssue ??
            "Target connector is read-only (writeEnabled=false). Enable Write on the linked connector.")
          : targetWriteEnabled == null
            ? (plan.preflight.targetWriteIssue ??
              "Target connector write capability was not resolved at preview — execute will re-check.")
            : null,
      // Unknown at preview is informative; execute still enforces the hard gate.
      blocking: targetWriteEnabled === false,
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
      id: "metadata-diff",
      label: hasChanges ? "Metadata changes to apply" : "Metadata already in sync",
      passed: true,
      blocking: false,
      detail: hasChanges
        ? `+${insert} ~${update} -${del} across ${tablesCount} table(s)`
        : "No row diffs — metadataSync is a no-op; deploy and post-metadata steps still run"
    }
  ]
}

export function execPreflightBlocked(plan: SyncPlan): boolean {
  return buildExecPreflightChecks(plan).some(
    (check) => check.blocking !== false && !check.passed
  )
}

export function execPreflightBlockReason(plan: SyncPlan): string | null {
  const failed = buildExecPreflightChecks(plan).filter(
    (check) => check.blocking !== false && !check.passed
  )
  if (failed.length === 0) return null
  return failed.map((check) => check.detail ?? check.label).join("; ")
}
