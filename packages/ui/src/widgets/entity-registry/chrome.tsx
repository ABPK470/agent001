/** Left rail width — keep in sync with grid template below. */
export const RAIL_WIDTH = "12.5rem"

export const RAIL_GRID = `grid-cols-[${RAIL_WIDTH}_1fr]` as const

/** Quiet bordered icon control — hover strengthens the frame, never a grey wash. */
export const ICON_BTN =
  "mia-control flex items-center justify-center w-9 h-9 shrink-0 text-text-muted focus-visible:outline-none disabled:opacity-40 disabled:cursor-not-allowed"

/** Unsaved / Modified — theme `--warning` chip (see `.mia-chip-dirty`). */
export const CHIP_DIRTY = "mia-chip-dirty px-2 py-0.5 text-xs"
export const CHIP_DIRTY_SM = "mia-chip-dirty px-2 py-0.5 text-[11px]"

/**
 * @deprecated Solid accent icon squares broke the dialect (purple next to grey +).
 * Alias of ICON_BTN — labeled CTAs use TEXT_BTN_PRIMARY / ACTION_BTN.
 */
export const ICON_BTN_PRIMARY = ICON_BTN

export const TOOLBAR =
  "flex min-w-0 flex-1 items-center justify-between gap-2"

export const TOOLBAR_ROW =
  "flex h-12 shrink-0 items-center px-3"

/** Vertical rule between toolbar control groups. */
export const TOOLBAR_DIVIDER = "h-4 w-px shrink-0 bg-overlay-3"

/** Place-tab chrome — shade peers; pair with PLACE_TAB_* (never underline). */
export const TAB_PILL =
  "px-2.5 py-1.5 text-sm transition-colors"

/**
 * Place / mode / list — global dialect (`lib/selection.ts`).
 * TAB_PILL_* = PLACE (where). Mode chips use SELECT_* / SegmentToggle directly.
 * Accent is never used for “selected.”
 */
export {
  PLACE_TAB_ACTIVE as TAB_PILL_ACTIVE,
  PLACE_TAB_IDLE as TAB_PILL_IDLE,
  SELECT_TRACK as TAB_SEGMENT_TRACK,
  LIST_ROW_ACTIVE,
  LIST_ROW_IDLE,
} from "../../lib/selection"

/** Sticky subheader inside a scrolling panel — export + view toggle. */
export const TAB_PANEL_HEADER =
  "sticky top-0 z-10 flex shrink-0 items-center justify-end gap-2 overflow-x-auto border-b border-border-subtle bg-inherit px-3 py-2"

export const TOOLBAR_TRACK_DIVIDER = "mx-0.5 h-6 w-px shrink-0 self-center bg-border-subtle"

/**
 * Bordered content shell — for floating surfaces (modals, popovers).
 * Never nest inside a tile that already owns `mia-surface` / widget shell.
 */
export const PANEL = "mia-surface overflow-hidden"

/**
 * Flush list inside a tile/tab — tile owns the frame; rows use hairline dividers.
 */
export const LIST_FLUSH = "overflow-hidden"

/**
 * Admin split shell — flush with the workspace tile (no nested canvas card).
 * Rail / detail separate with a hairline only; tile owns the surface paint.
 */
export const WIDGET_ENVELOPE =
  "flex min-h-0 flex-1 flex-col overflow-hidden"
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

/** Labeled primary CTA — accent is correct here (not on icon squares). */
export const ACTION_BTN =
  "inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-text-on-accent transition-colors hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed"

export const TEXT_BTN =
  "mia-control inline-flex items-center gap-1.5 px-2.5 py-1.5 text-sm font-medium disabled:opacity-40"

export const TEXT_BTN_PRIMARY =
  "inline-flex items-center gap-1.5 rounded-lg bg-accent px-2.5 py-1.5 text-sm font-medium text-text-on-accent transition-colors hover:bg-accent-hover disabled:opacity-40"

/** Uppercase field label — shared across entity-registry form editors. */
export const FIELD_LABEL = "field-label"
