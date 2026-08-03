/**
 * Build / filter run Resume + Rollback notification actions from live
 * capabilities (checkpoint + uncompensated file effects).
 */

import {
  canResumeRun,
  canRollbackRun,
  isRunCapabilityActionAllowed,
  type NotificationAction,
} from "@mia/shared-types"
import { runHasCompensatableEffects } from "../infra/effects/index.js"
import * as db from "../infra/persistence/sqlite.js"
import { NotificationActionType } from "../internal/enums/notifications.js"

export async function runCapabilityFlags(runId: string): Promise<{
  hasCheckpoint: boolean
  rollbackAvailable: boolean
}> {
  return {
    hasCheckpoint: !!await db.getCheckpoint(runId),
    rollbackAvailable: await runHasCompensatableEffects(runId),
  }
}

/** Resume / Rollback actions that are meaningful for this run right now. */
export async function buildRunCapabilityActions(
  runId: string,
  status: string,
): Promise<NotificationAction[]> {
  const caps = await runCapabilityFlags(runId)
  const actions: NotificationAction[] = []
  if (canResumeRun(status, caps.hasCheckpoint)) {
    actions.push({
      label: "Resume",
      action: NotificationActionType.ResumeRun,
      data: { runId },
    })
  }
  if (canRollbackRun(status, { rollbackAvailable: caps.rollbackAvailable })) {
    actions.push({
      label: "Rollback",
      action: NotificationActionType.RollbackRun,
      data: { runId },
    })
  }
  return actions
}

/**
 * Drop stale Resume/Rollback from a stored notification using current
 * run state. Other actions (View, approve, apply-diff, …) pass through.
 */
export async function filterNotificationActionsForCapabilities(
  runId: string | null,
  actions: NotificationAction[],
): Promise<NotificationAction[]> {
  if (!runId) return actions
  const run = await db.getRun(runId)
  if (!run) {
    // Run gone — capability actions are meaningless.
    return actions.filter(
      (a) => a.action !== NotificationActionType.ResumeRun
        && a.action !== NotificationActionType.RollbackRun,
    )
  }
  const caps = await runCapabilityFlags(runId)
  return actions.filter((a) =>
    isRunCapabilityActionAllowed(a.action, run.status, caps),
  )
}
