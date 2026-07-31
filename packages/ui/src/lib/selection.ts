/**
 * Product interaction dialect — one language for the whole UI.
 *
 * This is a product (web is only the interface). Simple means mature:
 * few concepts, zero ambiguity, sophisticated restraint.
 *
 * Two-ink: paper + ink. Structure is border and type weight — not grey plates.
 *
 * Accent  — brand / primary CTA only (Publish, Create, confirm).
 *           Never selected state, never nav active, never list highlight.
 * Selected — SELECT_* (ink fill chips/segments) or LIST_ROW_* (weight + left rule).
 * Hover    — stronger ink/border or text weight. Never grey wash / --hover-fill.
 * Focus    — ring on border-strong; must not look like selected.
 *
 * Border jobs (never mix):
 * - Surface  — one perimeter (tile, modal shell, floating panel, mia-surface)
 * - Divider  — hairline inside a surface (.mia-form-section, list rows, toolbar strip)
 * - Control  — idle border → hover border-strong; dense chrome = ghost (no idle box)
 *
 * Top bar: sheet names are quiet nav; active sheet = underline/weight (ink family).
 * Review widgets (Event Stream, Pipelines, Trace): one WidgetToolbar —
 *   leading | search | trailing — optional band 2 for chips/meta.
 *
 * Roles:
 * - SELECT_*   → exclusive chips / segments
 * - LIST_ROW_* → rows inside a list or rail
 * - CONTROL_*  → icon buttons / quiet actions (pair with .mia-control or ghost)
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

/**
 * Grouping for exclusive choices (Overview|JSON, Expanded|Collapsed).
 * Height follows `--control-h` so segments match WidgetToolbar search.
 */
export const SELECT_TRACK =
  "control-segment inline-flex items-stretch gap-0.5 rounded-lg border border-border p-0.5 h-[var(--control-h)] box-border"

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
