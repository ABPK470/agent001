/**
 * Run action capabilities — status alone is not enough.
 * Resume needs a checkpoint; rollback needs uncompensated file effects.
 */

import { RunStatus } from "../enums"
import type { RollbackPreview, Run } from "../types"

export function isLiveRunStatus(status: Run["status"]): boolean {
  return (
    status === RunStatus.Running
    || status === RunStatus.Pending
    || status === RunStatus.Planning
  )
}

export function isTerminalFailureStatus(status: Run["status"]): boolean {
  return (
    status === RunStatus.Failed
    || status === RunStatus.Cancelled
    || status === RunStatus.Crashed
  )
}

export function isTerminalRunStatus(status: Run["status"]): boolean {
  return (
    status === RunStatus.Completed
    || isTerminalFailureStatus(status)
  )
}

/** Cancel while the run is still in-flight (including waiting for approval). */
export function canCancelRun(status: Run["status"]): boolean {
  return isLiveRunStatus(status) || status === RunStatus.WaitingForApproval
}

/** Resume only when the server has a checkpoint (notifications already do this). */
export function canResumeRun(
  status: Run["status"],
  hasCheckpoint: boolean | null | undefined,
): boolean {
  if (!isTerminalFailureStatus(status)) return false
  return hasCheckpoint === true
}

/**
 * Offer rollback only when there is something to compensate and it has not
 * already been rolled back in this session / reported by the wire.
 */
export function canRollbackRun(
  status: Run["status"],
  opts: {
    rollbackAvailable: boolean | null | undefined
    alreadyRolledBack: boolean
  },
): boolean {
  if (opts.alreadyRolledBack) return false
  if (!isTerminalRunStatus(status)) return false
  return opts.rollbackAvailable === true
}

/** Confirm button — preview must have work and no blockers. */
export function canConfirmRollback(preview: RollbackPreview): boolean {
  return preview.wouldFail.length === 0 && preview.wouldCompensate.length > 0
}

export function rollbackAvailableFromPreview(preview: RollbackPreview): boolean {
  return canConfirmRollback(preview)
}
