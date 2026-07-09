/**
 * Memory tiers returned by retrieveContext for system-prompt injection.
 */
export interface MemoryPerTier {
  working: string
  episodic: string
  semantic: string
  /**
   * True when retrieved episodic summary metadata marks a prior substantive
   * success safe for the search_catalog shortcut banner. Defaults to false.
   */
  episodicShortcutEligible?: boolean
  /**
   * Ordered tool choreography from the best matching episodic row, when
   * shortcut-eligible. Hint only — args must be adapted to the current goal.
   */
  episodicChoreography?: string
}

export const EMPTY_MEMORY_PER_TIER: MemoryPerTier = {
  working: "",
  episodic: "",
  semantic: "",
  episodicShortcutEligible: false,
  episodicChoreography: undefined
}
