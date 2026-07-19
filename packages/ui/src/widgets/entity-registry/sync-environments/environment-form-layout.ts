/**
 * Configuration → Environments split-pane + env form layout contract.
 *
 * Same overflow chain as ConnectorsShell: grid rows/cols use minmax(0, …) so
 * expanding sections (e.g. Restricted → Allowed environments) scroll inside the
 * form pane instead of blowing the modal flex height and clipping chrome.
 */

/** Split list | form grid — must keep minmax(0) on both axes. */
export const CONFIG_SPLIT_GRID_CLASS =
  "grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(0,auto)_minmax(0,1fr)] gap-0 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:grid-rows-1"

/** Left catalog list column. */
export const CONFIG_SPLIT_LIST_CLASS =
  "flex min-h-0 min-w-0 max-h-[min(50dvh,22rem)] flex-col overflow-hidden border-b border-border-subtle p-5 lg:max-h-none lg:border-b-0 lg:border-r"

/** Right editor column root (header + scroll body). */
export const CONFIG_SPLIT_FORM_CLASS =
  "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"

/** Scroll host for SyncEnvironmentForm — sole vertical scroller in the editor. */
export const CONFIG_SPLIT_FORM_SCROLL_CLASS =
  "min-h-0 min-w-0 flex-1 overflow-auto bg-base/20 p-5"

/** SyncEnvironmentForm root — full width, no shrink-wrap. */
export const ENV_FORM_ROOT_CLASS = "w-full min-w-0 space-y-3"

/** Restricted-policy peer checklist — must stay block-level full width. */
export const ENV_POLICY_ALLOWED_CLASS =
  "w-full min-w-0 space-y-2 rounded-lg border border-border-subtle bg-base/20 p-3"

/** Unconstrained split-grid pattern that must not return (regression guard). */
export const FORBIDDEN_CONFIG_SPLIT_GRID_PATTERN =
  /className="grid min-h-0 flex-1 grid-cols-1 gap-0 lg:grid-cols-\[minmax\(0,0\.9fr\)_minmax\(0,1\.1fr\)\]"/
