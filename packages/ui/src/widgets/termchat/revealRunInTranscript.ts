/**
 * VirtualList-aware reveal for a chat turn.
 *
 * Stick-to-bottom (scrollHeight) alone is not enough: after a tall prior turn
 * the new latest run sits outside the mounted window until scrollToIndex
 * brings it in. Skipping reveal when the run is already "latest" was the
 * second-goal regression (composer running, transcript still on run 1).
 *
 * Live turns render in-flow after the VirtualList (Zone B) — reveal those
 * with scrollHeight pin, not scrollToIndex.
 */

export type RevealRunPlan = {
  index: number
  align: "end"
}

export type TranscriptReveal =
  | { kind: "live" }
  | { kind: "settled"; index: number; align: "end" }

export function planRevealRunInTranscript(
  settledRuns: ReadonlyArray<{ id: string }>,
  runId: string,
): RevealRunPlan | null {
  const index = settledRuns.findIndex((run) => run.id === runId)
  if (index < 0) return null
  return { index, align: "end" }
}

export function planTranscriptReveal(
  settledRuns: ReadonlyArray<{ id: string }>,
  liveRunId: string | null,
  runId: string,
): TranscriptReveal | null {
  if (liveRunId === runId) return { kind: "live" }
  const plan = planRevealRunInTranscript(settledRuns, runId)
  if (!plan) return null
  return { kind: "settled", index: plan.index, align: plan.align }
}
