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

/** Full overlay class string for bespoke modals (AgentEditor, ExecModal, …). */
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

/** Near full-viewport workspace panel (split-pane config, entity editors, …). */
export const MODAL_ENTITY_FOCUS_PANEL =
  "modal-entity-focus w-[min(98vw,calc(100vw-0.5rem))] max-w-none h-[min(96vh,calc(100dvh-0.5rem))]"

/** @deprecated Prefer MODAL_ENTITY_FOCUS_PANEL — alias kept for transitional imports. */
export const MODAL_ENTITY_WORKSPACE_PANEL = MODAL_ENTITY_FOCUS_PANEL

/** Compact read-only / confirm dialogs (retire, run detail, simple prompts). */
export const MODAL_DETAIL_PANEL =
  "w-[min(40rem,calc(100vw-1rem))] h-auto max-h-[min(85dvh,40rem)]"

/** Standard list/catalog viewers — Widget picker, catalog browsers. */
export const MODAL_VIEWER_PANEL =
  "w-[min(92vw,52rem)] h-[min(88vh,calc(100dvh-2rem))] min-h-[28rem]"

/** Full-bleed viewer on narrow viewports. */
export const MODAL_VIEWER_PANEL_MOBILE =
  "w-full max-w-none h-[min(96vh,calc(100dvh-0.5rem))]"

/**
 * Admin session modals that stay on the mid panel (About, Policies editor shell).
 * Audit / Usage use ModalShell size="focus" instead.
 */
export const MODAL_ADMIN_PANEL =
  "w-full max-w-[min(1080px,calc(100vw-1.5rem))] h-full sm:h-[90vh] sm:max-h-[920px]"

export function modalViewerPanelClass(mobile = false): string {
  return `${mobile ? MODAL_VIEWER_PANEL_MOBILE : MODAL_VIEWER_PANEL} flex flex-col overflow-hidden`
}
