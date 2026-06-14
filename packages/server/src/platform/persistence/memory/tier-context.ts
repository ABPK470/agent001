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
}

export const EMPTY_MEMORY_PER_TIER: MemoryPerTier = {
  working: "",
  episodic: "",
  semantic: "",
  episodicShortcutEligible: false
}
