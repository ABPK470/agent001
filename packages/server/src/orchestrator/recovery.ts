import * as db from "../db.js";
import { createNotification } from "./persistence.js";

// ── Recovery depends interface ────────────────────────────────────

interface RecoveryDeps {
  /** Resume a run from its checkpoint, returning the new run ID or null. */
  resumeRun(runId: string): string | null
}

// ── Recovery ──────────────────────────────────────────────────────

/**
 * On startup, find runs that were "running" when the server crashed,
 * mark them failed, and auto-resume from checkpoint where possible.
 */
export function recoverStaleRunsImpl(
  activeDeps: RecoveryDeps,
): { recovered: string[]; failed: string[] } {
  const staleRuns = db.findStaleRuns()
  const recovered: string[] = []
  const failed: string[] = []

  for (const stale of staleRuns) {
    db.markRunCrashed(stale.id)
    failed.push(stale.id)

    const checkpoint = db.getCheckpoint(stale.id)
    if (checkpoint) {
      const newRunId = activeDeps.resumeRun(stale.id)
      if (newRunId) {
        recovered.push(newRunId)
        createNotification({
          type: "run.recovered",
          title: "Run auto-recovered",
          message: `"${stale.goal.slice(0, 80)}" was interrupted by a server restart and has been automatically resumed.`,
          runId: newRunId,
          actions: [{ label: "View Run", action: "view-run", data: { runId: newRunId } }],
        })
      } else {
        createNotification({
          type: "run.failed",
          title: "Run interrupted",
          message: `"${stale.goal.slice(0, 80)}" was interrupted by a server restart. Resume manually from checkpoint.`,
          runId: stale.id,
          actions: [
            { label: "Review", action: "view-run", data: { runId: stale.id } },
            { label: "Resume", action: "resume-run", data: { runId: stale.id } },
          ],
        })
      }
    } else {
      createNotification({
        type: "run.failed",
        title: "Run lost",
        message: `"${stale.goal.slice(0, 80)}" was interrupted with no checkpoint available.`,
        runId: stale.id,
        actions: [{ label: "Review", action: "view-run", data: { runId: stale.id } }],
      })
    }
  }

  return { recovered, failed }
}
