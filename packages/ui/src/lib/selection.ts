/**
 * Selection / interaction dialect — one language for active / hover / focus.
 *
 * Light two-ink: structure is border + ink/paper, not grey plates.
 * Accent is brand/CTA sparingly — never “this is selected.”
 *
 * Border jobs (never mix):
 * - Surface  — one perimeter (`mia-surface`, widget/modal shell, PANEL)
 * - Divider  — hairline inside a surface (form sections: `.mia-form-section`)
 * - Control  — interactive idle → hover border-strong → focus ring
 * Never nest surface-in-surface (no FormSectionCard / FormFieldGroup frames).
 *
 * Roles:
 * - SELECT_*   → exclusive chips / segments (one filled choice)
 * - LIST_ROW_* → rows inside a list or rail (weight + ink, never a second frame)
 * - CONTROL_*  → icon buttons / quiet actions (pair with `.mia-control` in CSS)
 */

/** Selected / active choice — ink on paper (or paper on ink for filled). */
export const SELECT_ACTIVE =
  "bg-text text-text-on-accent font-medium border border-text"

/** Idle choice — frame only until hover. */
export const SELECT_IDLE =
  "border border-transparent text-text-muted transition-colors hover:border-border hover:text-text"

/**
 * List / rail row — selected.
 * No perimeter border: rows already live in a list (often inside a PANEL).
 * Signal is weight + ink, plus a left rule so active is unambiguous.
 */
export const LIST_ROW_ACTIVE =
  "relative text-text font-medium before:pointer-events-none before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-text"

/** List / rail row — idle. */
export const LIST_ROW_IDLE =
  "text-text-muted transition-colors hover:text-text"

/** Grouping for exclusive choices (Overview|JSON). No recessed trough. */
export const SELECT_TRACK =
  "inline-flex items-center gap-0.5 rounded-lg border border-border p-0.5"

/** Keyboard focus — must not compete with selection. */
export const SELECT_FOCUS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-strong"

/**
 * Quiet chrome control (pin / filter / icon square).
 * Prefer the `.mia-control` CSS class; this string is for Tailwind-only sites.
 * Never use transparent `--hover-fill` / `--select-fill` as the hover signal.
 */
export const CONTROL_IDLE =
  "border border-border text-text-muted transition-colors hover:border-border-strong hover:text-text"

/** Ghost chrome in a dense toolbar — border appears on hover only. */
export const CONTROL_GHOST =
  "border border-transparent text-text-muted transition-colors hover:border-border hover:text-text"
