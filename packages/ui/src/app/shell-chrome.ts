/**
 * Shell chrome — one top-bar geometry for chat and workspace.
 *
 * Modes must not diverge: same header height, horizontal inset, gap, and
 * brand row. Workspace only adds a sheet gutter *below* that shared band.
 */

/** Control row (brand, tab labels, actions) — Tailwind `h-9`. */
export const SHELL_CHROME_ROW_H = "2.25rem"

/** Shared header band — Tailwind `h-14`. */
export const SHELL_CHROME_HEADER_H = "3.5rem"

/** Horizontal inset — matches former chat `px-4` / `sm:px-6`. */
export const SHELL_CHROME_PAD_X = "1rem"
export const SHELL_CHROME_PAD_X_SM = "1.5rem"

/** Cluster gap — matches former chat `gap-2` / `sm:gap-4`. */
export const SHELL_CHROME_GAP = "0.5rem"
export const SHELL_CHROME_GAP_SM = "1rem"

/**
 * Base header class for every shell mode.
 * Layout tokens live on `.shell-chrome-header` in index.css.
 */
export const SHELL_CHROME_HEADER_CLASS =
  "shell-chrome-header relative z-20 flex shrink-0 select-none"

/** Workspace: same band + sheet gutter below for attached tabs. */
export const SHELL_CHROME_HEADER_WORKSPACE_CLASS =
  `${SHELL_CHROME_HEADER_CLASS} shell-chrome-header--workspace toolbar-shell`

/** Chat / threads: shared band only. */
export const SHELL_CHROME_HEADER_CHAT_CLASS = SHELL_CHROME_HEADER_CLASS
