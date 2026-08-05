/**
 * Auto-open policy for TermChat work chips (iteration + step blocks).
 * Parallel fan-out overrides this via keepOpen on StepBlock — do not use
 * this alone for subagent siblings.
 *
 * Open state must be derived in render from this policy (plus optional user
 * override). Syncing open via useEffect paints a collapse frame before
 * stick-to-bottom can catch up — that is the up/down scroll jump.
 */

export function shouldAutoOpenWorkChip(
  isLastWork: boolean,
  hasNarrativeAfter: boolean,
): boolean {
  return isLastWork && !hasNarrativeAfter
}

/** Step chip policy while the user has not overridden the fold. */
export function stepChipAutoOpen(
  hasRunning: boolean,
  keepOpen: boolean,
  status: string,
): boolean {
  if (hasRunning || keepOpen) return true
  return status === "running"
}

/** User override wins; otherwise follow auto policy in the same render. */
export function workChipOpen(
  userToggled: boolean,
  userOpen: boolean,
  autoOpen: boolean,
): boolean {
  return userToggled ? userOpen : autoOpen
}
