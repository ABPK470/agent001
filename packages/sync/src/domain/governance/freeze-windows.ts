/**
 * Freeze-window vocabulary.
 */
export interface FreezeWindowDefinition {
  /** Stable id (matches `EntityPolicies.freezeWindowIds[]`). */
  id: string
  displayName: string
  description: string
  /** ISO-8601 inclusive start. */
  startsAt: string
  /** ISO-8601 exclusive end. */
  endsAt: string
}

export interface FreezeEvaluation {
  /** True when the window applies right now. */
  active: boolean
  /** Resolved windows that matched the entity's freezeWindowIds[]. */
  matched: FreezeWindowDefinition[]
  /** Active windows (subset of matched whose [start, end) brackets now). */
  activeWindows: FreezeWindowDefinition[]
  /** Ids referenced by the entity that have no registry definition. */
  unknownIds: string[]
}
