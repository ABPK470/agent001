/**
 * Shared modal shell — matches WidgetCatalog backdrop and panel chrome.
 */

import { X } from "lucide-react"
import type { JSX, ReactNode } from "react"
import { useEffect, useId } from "react"
import { createPortal } from "react-dom"

import { IconButton, TOOLBAR_ICON } from "./IconButton"
import {
  MODAL_DETAIL_PANEL,
  MODAL_ENTITY_FOCUS_PANEL,
  MODAL_ENTITY_WORKSPACE_PANEL,
  type ModalOverlayIntent,
  modalOverlayClass,
  MODAL_SURFACE_CLASS,
} from "./modal-overlay"

export {
  MODAL_DETAIL_PANEL,
  MODAL_ENTITY_FOCUS_PANEL,
  MODAL_ENTITY_WORKSPACE_PANEL,
  modalOverlayClass,
  type ModalOverlayIntent,
} from "./modal-overlay"

const MODAL_BASE_Z = 50
const MODAL_Z_STEP = 10

/** Only the topmost modal should react to Escape. */
const modalStack: string[] = []

export type ModalShellSize = "detail" | "default" | "workspace" | "focus"

export type ModalShellScrim = "default" | "strong" | "focus"

export interface ModalShellProps {
  title: string
  subtitle?: string
  icon?: ReactNode
  onClose: () => void
  /** @deprecated Use size="detail" | "default" | "focus" */
  widthClass?: string
  /**
   * detail    — compact confirm / simple read-only (retire, history)
   * default   — tall editor shell
   * focus     — configuration workspace (near full-viewport; split-pane editors)
   * workspace — deprecated alias for focus
   */
  size?: ModalShellSize
  /**
   * Override automatic scrim tier. Defaults: detail → strong, focus/workspace → focus edge, default → normal.
   */
  scrim?: ModalShellScrim
  /** Nested modals (table editor, confirm dialogs) — higher values stack above parent shells. */
  stackLevel?: number
  /** @deprecated Use size="detail" */
  compact?: boolean
  children: ReactNode
  footer?: ReactNode
}

const SIZE_PANEL: Record<ModalShellSize, string> = {
  detail: MODAL_DETAIL_PANEL,
  default: "w-full max-w-3xl h-[min(88vh,900px)] min-h-[32rem]",
  focus: MODAL_ENTITY_FOCUS_PANEL,
  workspace: MODAL_ENTITY_FOCUS_PANEL,
}

function resolveOverlayIntent(
  size: ModalShellSize,
  scrim?: ModalShellScrim,
): ModalOverlayIntent {
  if (scrim === "strong") return "detail"
  if (scrim === "focus") return "focus"
  if (scrim === "default") return "default"
  if (size === "detail") return "detail"
  if (size === "focus" || size === "workspace") return "focus"
  return "default"
}

export function ModalShell({
  title,
  subtitle,
  icon,
  onClose,
  widthClass,
  size,
  scrim,
  stackLevel = 0,
  compact = false,
  children,
  footer,
}: ModalShellProps): JSX.Element {
  const stackId = useId()
  const resolvedSize: ModalShellSize = size ?? (compact ? "detail" : "default")
  const panelClass = widthClass
    ? `${widthClass} flex flex-col overflow-hidden`
    : `${SIZE_PANEL[resolvedSize]} flex flex-col overflow-hidden`
  const zIndex = MODAL_BASE_Z + stackLevel * MODAL_Z_STEP
  /** Nested shells share the root scrim — avoid stacking multiple dim layers. */
  const showScrim = stackLevel === 0
  const overlayIntent = resolveOverlayIntent(resolvedSize, scrim)

  useEffect(() => {
    modalStack.push(stackId)
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return
      if (modalStack[modalStack.length - 1] !== stackId) return
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    window.addEventListener("keydown", onKey, true)
    return () => {
      const idx = modalStack.lastIndexOf(stackId)
      if (idx >= 0) modalStack.splice(idx, 1)
      window.removeEventListener("keydown", onKey, true)
    }
  }, [onClose, stackId])

  return createPortal(
    <div
      className={
        showScrim
          ? modalOverlayClass(overlayIntent)
          : "fixed inset-0 flex items-center justify-center bg-transparent p-0"
      }
      style={{ zIndex }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-surface-title"
      onClick={onClose}
    >
      <div
        className={`${MODAL_SURFACE_CLASS} ${panelClass}`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-border-subtle px-6 pt-5 pb-4">
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2.5">
              {icon && <span className="shrink-0 text-text-muted">{icon}</span>}
              <h2 id="modal-surface-title" className="text-lg font-semibold text-text">
                {title}
              </h2>
            </div>
            {subtitle && (
              <p className="mt-1.5 text-sm leading-snug text-text-muted">
                {subtitle}
              </p>
            )}
          </div>
          <IconButton label="Close" onClick={onClose}>
            <X {...TOOLBAR_ICON} />
          </IconButton>
        </header>

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>

        {footer && (
          <footer className="flex shrink-0 items-center gap-2 border-t border-border-subtle px-6 py-4">
            {footer}
          </footer>
        )}
      </div>
    </div>,
    document.body,
  )
}
