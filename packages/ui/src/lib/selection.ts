/**
 * Selection dialect — one language for active / selected / hover across the UI.
 *
 * Accent is brand, CTA, and status badges only — never “this is selected.”
 * Lists, tabs, segments, filters, and view chips all share these fills.
 */

/** Selected / active choice or list row. */
export const SELECT_ACTIVE = "bg-[var(--select-fill)] text-text font-medium"

/** Idle choice — muted until hover. */
export const SELECT_IDLE =
  "text-text-muted transition-colors hover:bg-[var(--hover-fill)] hover:text-text"

/** Grouping for exclusive choices (Overview|JSON). No recessed trough. */
export const SELECT_TRACK = "inline-flex items-center gap-0.5 rounded-lg p-0.5"

/** Keyboard focus — must not compete with selection fill. */
export const SELECT_FOCUS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/35"
