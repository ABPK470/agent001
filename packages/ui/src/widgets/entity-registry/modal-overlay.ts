/**
 * Shared modal overlay chrome — single scrim + padding by intent.
 *
 * All modals use the same dark backdrop (`bg-scrim-strong`). Intent only affects padding.
 */

export type ModalOverlayIntent = "detail" | "default" | "focus"

/** Canonical modal backdrop — near-opaque black (see `--scrim-strong` in index.css). */
export const MODAL_OVERLAY_SCRIM_CLASS = "bg-scrim-strong"

const OVERLAY_BASE = "fixed inset-0 flex items-center justify-center"

const OVERLAY_PADDING: Record<ModalOverlayIntent, string> = {
  detail: "p-2 sm:p-4",
  default: "p-2 sm:p-4",
  focus: "p-0.5 sm:p-1",
}

export type ModalOverlayOptions = {
  /** Extra utility classes (e.g. overflow-y-auto). */
  className?: string
  /** Tailwind z-index class — defaults to z-50. */
  zIndexClass?: string
}

/** Full overlay class string for bespoke modals (ExecModal, …). */
export function modalOverlayClass(
  intent: ModalOverlayIntent,
  options?: ModalOverlayOptions,
): string {
  return [
    OVERLAY_BASE,
    options?.zIndexClass ?? "z-50",
    MODAL_OVERLAY_SCRIM_CLASS,
    OVERLAY_PADDING[intent],
    options?.className,
  ]
    .filter(Boolean)
    .join(" ")
}

/** Panel surface shared by ModalShell and legacy shells. */
export const MODAL_SURFACE_CLASS =
  "modal-surface bg-surface shadow-2xl rounded-xl sm:rounded-2xl"

/**
 * Tall modal height — fills the monitor with a small margin.
 * No absolute px ceiling (900/920/960) so large screens keep growing.
 */
export const MODAL_TALL_HEIGHT = "h-[min(96vh,calc(100dvh-1rem))]"

/** Near full-viewport workspace panel (split-pane config, entity editors, …). */
export const MODAL_ENTITY_FOCUS_PANEL =
  `modal-entity-focus w-[min(98vw,calc(100vw-0.5rem))] max-w-none ${MODAL_TALL_HEIGHT}`

/** @deprecated Prefer MODAL_ENTITY_FOCUS_PANEL — alias kept for transitional imports. */
export const MODAL_ENTITY_WORKSPACE_PANEL = MODAL_ENTITY_FOCUS_PANEL

/** Compact read-only / confirm dialogs (retire, history) — height follows content. */
export const MODAL_DETAIL_PANEL =
  "w-[min(40rem,calc(100vw-1rem))] h-auto max-h-[min(85dvh,calc(100dvh-2rem))]"

/** Mid-width tall shell (default ModalShell, import gate, …). */
export const MODAL_DEFAULT_PANEL =
  `w-full max-w-3xl ${MODAL_TALL_HEIGHT} min-h-[32rem]`

/** Standard list/catalog viewers — Widget picker, catalog browsers. */
export const MODAL_VIEWER_PANEL =
  `w-[min(92vw,52rem)] ${MODAL_TALL_HEIGHT} min-h-[28rem]`

/** Full-bleed viewer on narrow viewports. */
export const MODAL_VIEWER_PANEL_MOBILE =
  `w-full max-w-none ${MODAL_TALL_HEIGHT}`

/**
 * Admin session modals (Policies, About) — mid width, tall viewport fill.
 * Audit / Usage use ModalShell size="focus".
 */
export const MODAL_ADMIN_PANEL =
  `w-full max-w-[min(1080px,calc(100vw-1.5rem))] ${MODAL_TALL_HEIGHT}`

export function modalViewerPanelClass(mobile = false): string {
  return `${mobile ? MODAL_VIEWER_PANEL_MOBILE : MODAL_VIEWER_PANEL} flex flex-col overflow-hidden`
}
