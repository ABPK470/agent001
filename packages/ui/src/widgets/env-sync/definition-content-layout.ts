/**
 * Sync Definition modal layout — scroll contract.
 *
 * Only `.env-sync-definition-table-scroll` may scroll. Header metadata and the
 * table column header stay visible; the modal shell must not show a body scrollbar.
 */

/** Modal body root — flex column, no overflow scroll on this node. */
export const DEFINITION_MODAL_BODY_CLASS =
  "env-sync-definition-body flex min-h-0 flex-1 flex-col overflow-hidden"

/** Published-definition metadata block above the table. */
export const DEFINITION_MODAL_HEADER_CLASS = "env-sync-definition-header shrink-0"

/** Table panel wrapper — no scroll on this node. */
export const DEFINITION_TABLE_PANEL_CLASS =
  "env-sync-definition-table-panel min-h-0 flex-1 flex flex-col px-5 pb-2"

/** Bordered table shell — column header stays in the non-scrolling block. */
export const DEFINITION_TABLE_SHELL_CLASS =
  "env-sync-definition-table-shell flex min-h-0 flex-1 flex-col overflow-hidden rounded border border-border/40"

/** Sole vertical scroll host for dependency table rows (scrollbar hidden via global CSS). */
export const DEFINITION_TABLE_BODY_SCROLL_CLASS =
  "env-sync-definition-table-scroll min-h-0 flex-1 overflow-y-auto"

/** Fixed column header above the scrolling row list (not CSS sticky — immune to overflow-hidden). */
export const DEFINITION_TABLE_HEADER_CLASS =
  "env-sync-definition-table-header shrink-0 grid grid-cols-[2rem_1fr_auto_auto_auto_auto] gap-2 border-b border-border/40 bg-elevated px-3 py-1.5 text-xs text-text-muted/60"

/** Discrepancies + ownership footer below the scroll region. */
export const DEFINITION_MODAL_FOOTER_CLASS = "env-sync-definition-footer shrink-0"

/** Layout classes that must not appear on the modal body root (regression guard). */
export const FORBIDDEN_DEFINITION_MODAL_BODY_SCROLL_MARKERS = [
  "show-scrollbar",
  "overflow-y-auto",
  "overflow-auto",
] as const
