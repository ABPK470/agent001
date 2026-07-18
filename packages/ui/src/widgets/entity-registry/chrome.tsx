/** Left rail width — keep in sync with grid template below. */
export const RAIL_WIDTH = "12.5rem"

export const RAIL_GRID = `grid-cols-[${RAIL_WIDTH}_1fr]` as const

export const ICON_BTN =
  "flex items-center justify-center w-9 h-9 shrink-0 rounded-lg border border-border-subtle text-text-muted transition-colors hover:bg-elevated hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40 disabled:cursor-not-allowed"

export const ICON_BTN_PRIMARY =
  "flex items-center justify-center w-9 h-9 shrink-0 rounded-lg bg-accent text-text transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40 disabled:cursor-not-allowed"

export const TOOLBAR =
  "flex min-w-0 flex-1 items-center justify-between gap-2"

export const TOOLBAR_ROW =
  "flex h-12 shrink-0 items-center px-3"

/** Vertical rule between toolbar control groups. */
export const TOOLBAR_DIVIDER = "h-4 w-px shrink-0 bg-overlay-3"

export const TAB_PILL =
  "rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors"

/** Selected / idle fills for `TAB_PILL` (section tabs + multi-select filter tabs). */
export const TAB_PILL_ACTIVE = "bg-accent/15 text-accent"
export const TAB_PILL_IDLE = "text-text-muted hover:bg-elevated hover:text-text"

/** Sticky subheader inside a scrolling panel — export + view toggle. */
export const TAB_PANEL_HEADER =
  "sticky top-0 z-10 flex shrink-0 items-center justify-end gap-2 overflow-x-auto border-b border-border-subtle bg-canvas px-3 py-2"

/** Shared track for segment toggles and toolbar listboxes. */
export const TAB_SEGMENT_TRACK =
  "inline-flex items-center gap-0.5 rounded-lg border border-border-subtle bg-canvas p-1"

export const TOOLBAR_TRACK_DIVIDER = "mx-0.5 h-6 w-px shrink-0 self-center bg-border-subtle"

/** Bordered content shell — rounded corners on the container, not on icon buttons. */
export const PANEL =
  "overflow-hidden rounded-lg border border-border-subtle"

/** Sidebar + detail pane — single rounded shell inside the widget. */
export const WIDGET_ENVELOPE =
  "flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border-subtle bg-canvas"
export const TAB_SHELL = "flex h-full min-h-0 flex-col overflow-hidden"

/** Same height and horizontal inset as the main tab toolbar row (`TOOLBAR_ROW`). */
export const TAB_SUBHEADER =
  `${TOOLBAR_ROW} gap-2 overflow-x-auto border-b border-border-subtle`

export const TAB_BODY =
  "flex min-h-0 flex-1 flex-col overflow-hidden px-3 py-3"

export const TAB_BODY_INNER =
  "flex min-h-0 flex-1 flex-col overflow-hidden"

export const TAB_ERROR = "shrink-0 px-3 py-1.5 text-sm text-error"

export const TAB_CODE =
  "entity-registry-entity__code m-0 font-mono text-sm leading-relaxed text-text"

export const SECTION_TITLE = "text-base font-semibold text-text"

/** Right-panel title when creating or editing (Sync metadata, etc.). */
export const FORM_HEADING = SECTION_TITLE

/** In-form section divider title (Execution steps, Phase behavior). */
export const SUBSECTION_HEADING = "text-sm font-semibold text-text"

/** Body help, empty states, built-in notices. */
export const HELP_TEXT = "text-sm leading-relaxed text-text-muted"

/** Bordered inline notice below a form heading. */
export const FORM_NOTICE = `${HELP_TEXT} rounded-lg border border-border-subtle bg-base/50 px-3 py-2`

/** Secondary line in lists (id, step count, built-in). */
export const META_TEXT = "text-xs text-text-muted"

export const ACTION_BTN =
  "inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-text transition-colors hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed"

export const TEXT_BTN =
  "inline-flex items-center gap-1.5 rounded-lg border border-border-subtle px-2.5 py-1.5 text-sm font-medium text-text-muted transition-colors hover:bg-elevated hover:text-text disabled:opacity-40"

export const TEXT_BTN_PRIMARY =
  "inline-flex items-center gap-1.5 rounded-lg bg-accent px-2.5 py-1.5 text-sm font-medium text-text transition-colors hover:bg-accent-hover disabled:opacity-40"

/** Uppercase field label — shared across entity-registry form editors. */
export const FIELD_LABEL = "field-label"
