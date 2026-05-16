/**
 * Shared modal shell — portal-rendered, escape-key + scrim-click close.
 *
 * Matches the design vocabulary of `EnvSync` so the registry's modals
 * sit naturally inside the platform UI. Use for forms (New/Edit/Import)
 * and confirmation dialogs (Re-seed/Retire).
 */

import { X } from "lucide-react"
import type { JSX, ReactNode } from "react"
import { useEffect } from "react"
import { createPortal } from "react-dom"

export interface ModalShellProps {
  title: string
  subtitle?: string
  icon?: ReactNode
  onClose: () => void
  /** Overall max width — default 720px (matches EnvSync's modal vocabulary). */
  widthClass?: string
  /**
   * When true, the dialog hugs its content (auto height, capped at
   * 88vh). Use for short forms (≤6 fields). Default is the tall,
   * shape-stable shell used by tabbed editors.
   */
  compact?: boolean
  children: ReactNode
  footer?: ReactNode
}

export function ModalShell({
  title,
  subtitle,
  icon,
  onClose,
  widthClass = "max-w-3xl",
  compact = false,
  children,
  footer,
}: ModalShellProps): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose() }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-scrim p-2 sm:p-4"
      onClick={onClose}
    >
      <div
        className={`flex w-full ${widthClass} ${
          compact
            ? "max-h-[88vh]"
            : "h-[88vh] min-h-[640px] max-h-[94vh]"
        } flex-col overflow-hidden rounded-xl bg-surface shadow-2xl`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-border-subtle px-5 py-4">
          <div className="flex items-center gap-2.5 min-w-0">
            {icon}
            <h2 className="text-base font-semibold text-text truncate">{title}</h2>
            {subtitle && (
              <span className="text-xs text-text-muted font-mono truncate">{subtitle}</span>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-text-muted hover:bg-overlay-2 hover:text-text"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">{children}</div>
        {footer && (
          <div className="flex shrink-0 items-center gap-2 border-t border-border-subtle px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}
