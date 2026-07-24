/**
 * Auto-open policy for TermChat work chips (iteration + step blocks).
 * Parallel fan-out overrides this via keepOpen on StepBlock — do not use
 * this alone for subagent siblings.
 */

export function shouldAutoOpenWorkChip(
  isLastWork: boolean,
  hasNarrativeAfter: boolean,
): boolean {
  return isLastWork && !hasNarrativeAfter
}
