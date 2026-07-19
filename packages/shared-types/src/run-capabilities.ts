/**
 * Run action capabilities — platform truth for Resume / Rollback / Cancel.
 *
 * Status alone is not enough: Resume needs a checkpoint; Rollback needs
 * uncompensated file effects. UI widgets, chat slash commands, and
 * notification attach/list all use these same rules.
 */

import { RunStatus } from "@mia/shared-enums"

export function isLiveRunStatus(status: string): boolean {
  return (
    status === RunStatus.Running
    || status === RunStatus.Pending
    || status === RunStatus.Planning
  )
}

export function isTerminalFailureStatus(status: string): boolean {
  return (
    status === RunStatus.Failed
    || status === RunStatus.Cancelled
    || status === RunStatus.Crashed
  )
}

export function isTerminalRunStatus(status: string): boolean {
  return status === RunStatus.Completed || isTerminalFailureStatus(status)
}

/** Cancel while the run is still in-flight (including waiting for approval). */
export function canCancelRun(status: string): boolean {
  return isLiveRunStatus(status) || status === RunStatus.WaitingForApproval
}

/** Resume only when the server has a checkpoint for a terminal failure. */
export function canResumeRun(
  status: string,
  hasCheckpoint: boolean | null | undefined,
): boolean {
  if (!isTerminalFailureStatus(status)) return false
  return hasCheckpoint === true
}

/**
 * Offer rollback only when there is something to compensate and it has not
 * already been rolled back (session flag or wire `rollbackAvailable: false`).
 */
export function canRollbackRun(
  status: string,
  opts: {
    rollbackAvailable: boolean | null | undefined
    alreadyRolledBack?: boolean
  },
): boolean {
  if (opts.alreadyRolledBack) return false
  if (!isTerminalRunStatus(status)) return false
  return opts.rollbackAvailable === true
}

export interface RollbackConfirmPreview {
  wouldCompensate: unknown[]
  wouldFail: unknown[]
}

/** Confirm button — preview must have work and no blockers. */
export function canConfirmRollback(preview: RollbackConfirmPreview): boolean {
  return preview.wouldFail.length === 0 && preview.wouldCompensate.length > 0
}

export function rollbackAvailableFromPreview(preview: RollbackConfirmPreview): boolean {
  return canConfirmRollback(preview)
}

/** Whether a stored notification action is still meaningful for this run. */
export function isRunCapabilityActionAllowed(
  action: string,
  status: string,
  caps: {
    hasCheckpoint: boolean | null | undefined
    rollbackAvailable: boolean | null | undefined
  },
): boolean {
  if (action === "resume-run") return canResumeRun(status, caps.hasCheckpoint)
  if (action === "rollback-run") {
    return canRollbackRun(status, { rollbackAvailable: caps.rollbackAvailable })
  }
  return true
}
