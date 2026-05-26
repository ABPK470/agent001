import { EventType } from "@mia/agent"
import * as db from "../adapters/persistence/sqlite.js"
import { NotificationActionType } from "../enums/notifications.js"
import { broadcast } from "../event-broadcaster.js"
import { createNotification } from "./persistence.js"

// ── Recovery depends interface ────────────────────────────────────

interface RecoveryDeps {
  /** Resume a run from its checkpoint, returning the new run ID or null. */
  resumeRun(runId: string): string | null
}

// ── Recovery ──────────────────────────────────────────────────────

/**
 * On startup, find runs that were "running" / "pending" / "planning" when the
 * server crashed (or was restarted) and mark them failed.
 *
 * We deliberately DO NOT auto-resume from checkpoint here — silently spinning
 * up a fresh run on boot is surprising and tends to produce phantom "running"
 * rows in the UI when the resumed loop fails immediately. Instead, the
 * notification gives the user a one-click Resume action.
 *
 * `activeDeps` is kept on the signature for parity with callers and possible
 * future opt-in auto-resume; it's intentionally unused right now.
 */
export function recoverStaleRunsImpl(
  _activeDeps: RecoveryDeps,
): { recovered: string[]; failed: string[] } {
  const staleRuns = db.findStaleRuns()
  const failed: string[] = []

  for (const stale of staleRuns) {
    db.markRunCrashed(stale.id)
    failed.push(stale.id)
    // Broadcast a synthetic run.failed so any live UI (PIPELINES,
    // ActiveUsers in-flight count, run.status badges, ...) settles
    // immediately instead of waiting for the next manual refetch.
    broadcast({ type: EventType.RunFailed, data: { runId: stale.id, error: "Server restarted — run interrupted" } })

    const checkpoint = db.getCheckpoint(stale.id)
    if (checkpoint) {
      createNotification({
        type: EventType.RunFailed,
        title: "Run interrupted",
        message: `"${stale.goal.slice(0, 80)}" was interrupted by a server restart. Resume manually from checkpoint.`,
        runId: stale.id,
        actions: [
          { label: "Review", action: NotificationActionType.ViewRun, data: { runId: stale.id } },
          { label: "Resume", action: NotificationActionType.ResumeRun, data: { runId: stale.id } },
        ],
      })
    } else {
      createNotification({
        type: EventType.RunFailed,
        title: "Run lost",
        message: `"${stale.goal.slice(0, 80)}" was interrupted with no checkpoint available.`,
        runId: stale.id,
        actions: [{ label: "Review", action: NotificationActionType.ViewRun, data: { runId: stale.id } }],
      })
    }
  }

  return { recovered: [], failed }
}
