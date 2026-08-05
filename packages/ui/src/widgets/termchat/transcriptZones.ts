/**
 * Two-zone transcript — settled history (VirtualList) vs live turn (in-flow).
 *
 * High-frequency height changes must not remasure historical virtual rows.
 * The active streaming turn renders after the list in normal document flow;
 * the bottom paper spacer stays after that (empty air, not a dock).
 */

import { RunStatus } from "../../enums"

export function isRunActiveStatus(status: string | null | undefined): boolean {
  return (
    status === RunStatus.Pending
    || status === RunStatus.Running
    || status === RunStatus.Planning
    || status === RunStatus.WaitingForApproval
  )
}

/** Scoped active turn belongs in Zone B (in-flow), not VirtualList. */
export function isLiveTranscriptTurn(run: {
  status: string
  streamingAnswer?: string | null
}): boolean {
  return isRunActiveStatus(run.status) || Boolean(run.streamingAnswer?.length)
}

export function deriveTranscriptZones<T extends { id: string; status: string; streamingAnswer?: string | null }>(
  displayRuns: ReadonlyArray<T>,
  scopedActiveRun: T | undefined,
  scopedActiveRunId: string | null,
): { settledRuns: T[]; liveRun: T | null } {
  const liveId =
    scopedActiveRun
    && scopedActiveRunId === scopedActiveRun.id
    && isLiveTranscriptTurn(scopedActiveRun)
      ? scopedActiveRun.id
      : null

  // Prefer the display-list row (resume-chain collapse) over the raw store row.
  const liveRun = liveId
    ? (displayRuns.find((r) => r.id === liveId) ?? scopedActiveRun ?? null)
    : null

  const settledRuns = liveRun
    ? displayRuns.filter((r) => r.id !== liveRun.id)
    : [...displayRuns]

  return { settledRuns, liveRun }
}
