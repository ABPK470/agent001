/**
 * In-widget modal overlay — stays inside the host tile.
 *
 * Use when a widget intentionally keeps overlays local (Pipelines).
 * Must be a descendant of a `relative` (or positioned) host that is
 * the widget root — never under overflow-y-auto row nests.
 *
 * Sizes with % of the host, not vh/vw, so it cannot overflow the tile.
 */

import type { ReactNode } from "react"
import { useEffect } from "react"

export function WidgetLocalOverlay({
  onClose,
  children,
  "aria-label": ariaLabel,
}: {
  onClose: () => void
  children: ReactNode
  "aria-label"?: string
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [onClose])

  return (
    <div
      className="absolute inset-0 z-20 flex min-h-0 min-w-0 items-stretch justify-stretch p-2 sm:p-2.5 bg-scrim-strong"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
    >
      <div
        className="flex min-h-0 min-w-0 w-full max-w-full flex-1 flex-col overflow-hidden rounded-lg border border-border-subtle bg-base shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  )
}

/** Viewport-centered overlay (portal target body). Same chrome as local, full screen. */
export function ViewportOverlay({
  onClose,
  children,
  "aria-label": ariaLabel,
}: {
  onClose: () => void
  children: ReactNode
  "aria-label"?: string
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-scrim-strong"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
    >
      <div
        className="flex max-h-[min(96vh,calc(100dvh-1rem))] w-full max-w-4xl flex-col overflow-hidden rounded-lg border border-border-subtle bg-base shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  )
}

export type ModalHost = "local" | "viewport"
