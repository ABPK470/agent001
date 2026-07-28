/**
 * VirtualList-aware reveal for a chat turn.
 *
 * Stick-to-bottom (scrollHeight) alone is not enough: after a tall prior turn
 * the new latest run sits outside the mounted window until scrollToIndex
 * brings it in. Skipping reveal when the run is already "latest" was the
 * second-goal regression (composer running, transcript still on run 1).
 */

export type RevealRunPlan = {
  index: number
  align: "end"
}

export function planRevealRunInTranscript(
  displayRuns: ReadonlyArray<{ id: string }>,
  runId: string,
): RevealRunPlan | null {
  const index = displayRuns.findIndex((run) => run.id === runId)
  if (index < 0) return null
  return { index, align: "end" }
}
