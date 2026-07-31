/**
 * Product interaction dialect — one language for the whole UI.
 *
 * Two-ink: paper + ink. Quiet ink washes for hover/place — never left-rule ticks.
 *
 * Orient in ~300ms — three questions, three signals (never share a look):
 *   1. Where am I?   PLACE_* / LIST_ROW_*  — shade + weight (never underline ticks)
 *   2. What mode?    SELECT_*              — shade fill + weight (never inverted black pill)
 *   3. What can I press? CONTROL_*         — keep the frame; hover/press fills the bg
 *
 * Hover signal is background wash — never “slightly stronger border” alone
 * (that’s invisible on light paper).
 *
 * Tree elbows (ReviewTree / thread-nav-run::before) are hierarchy connectors —
 * never reuse that geometry for “selected.”
 *
 * Accent / labeled CTA may use solid ink fill — never “selected.”
 */

/**
 * Place tab — where inside a surface (Overview | Tables).
 * Quiet shade + weight. Layout sheets use inset `.view-tab` pills in CSS.
 * Never underline.
 */
export const PLACE_TAB_ACTIVE =
  "rounded-md bg-[var(--select-fill)] text-text font-semibold border border-transparent"

/** Place tab — idle peer; hover fills the cell. */
export const PLACE_TAB_IDLE =
  "rounded-md bg-transparent text-text-muted font-medium border border-transparent transition-colors hover:text-text hover:bg-[var(--hover-fill)]"

/**
 * Mode choice — quiet select-fill + weight.
 * Only inside SELECT_TRACK (or an equivalent framed group).
 * Never use alone for filter chips — transparent border reads as plain text;
 * those are CONTROL_* (keep the frame).
 * Never inverted black pill; never a screaming ink outline frame.
 */
export const SELECT_ACTIVE =
  "bg-[var(--select-fill)] text-text font-semibold border border-transparent"

/**
 * Idle mode choice — muted. Hover fills the cell (keep border slot stable;
 * do not “highlight” by thickening the border).
 * Paired with SELECT_TRACK — not for free-floating filter toggles.
 */
export const SELECT_IDLE =
  "border border-transparent text-text-muted transition-colors hover:text-text hover:bg-[var(--hover-fill)]"

/**
 * List / rail row — selected place among peers.
 * Quiet select-fill + semibold. Radius matches Threads (`--list-row-radius`).
 * Never a left-rule tick.
 */
export const LIST_ROW_ACTIVE =
  "rounded-[var(--list-row-radius)] text-text font-semibold bg-[var(--select-fill)]"

/** List / rail row — idle; hover fills a readable shade. */
export const LIST_ROW_IDLE =
  "rounded-[var(--list-row-radius)] text-text-muted transition-colors hover:text-text hover:bg-[var(--hover-fill)]"

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
 * Quiet chrome control (pin / filter choice / icon square).
 * Prefer `.mia-control`. Hover keeps the frame and fills the bg.
 * FilterSheet choice grids and free-floating filter nav use this — not SELECT_*.
 */
export const CONTROL_IDLE =
  "border border-border text-text-muted transition-colors hover:text-text hover:bg-[var(--hover-fill)]"

/** Ghost chrome in a dense toolbar — shade fills the hit target on hover. */
export const CONTROL_GHOST =
  "border border-transparent text-text-muted transition-colors hover:text-text hover:bg-[var(--hover-fill)]"

/**
 * Control pressed / on / menu-open.
 * Keep the frame; fill the bg. No border thickening as the signal.
 * Dirty-with-nowhere-to-go stays here; the *next* action uses CONTROL_READY.
 */
export const CONTROL_PRESSED =
  "border border-border text-text font-medium bg-[var(--select-fill)]"

/**
 * Next-step / go-to control — navigate the eye in a multi-step flow.
 * Solid ink fill (labeled CTA family). Never SELECT_*; never share a look
 * with pressed/place. Pair with `.mia-control` via `mia-control--ready`.
 */
export const CONTROL_READY = "mia-control--ready"
