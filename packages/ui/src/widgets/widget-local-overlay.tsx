/**
 * Widget-local overlay that cannot be clipped by tile overflow/transform.
 *
 * Absolute-in-widget fails under WidgetShell `overflow-hidden` + tile
 * `transform` containing blocks. Instead: portal to document.body and
 * pin the scrim to the host element's getBoundingClientRect — visually
 * local, always interactive, sized to the widget.
 */

import type { ReactNode, RefObject } from "react"
import { useEffect, useLayoutEffect, useState } from "react"
import { createPortal } from "react-dom"

type HostBox = { top: number; left: number; width: number; height: number }

function readHostBox(host: HTMLElement): HostBox {
  const r = host.getBoundingClientRect()
  return { top: r.top, left: r.left, width: r.width, height: r.height }
}

export function WidgetLocalOverlay({
  hostRef,
  onClose,
  children,
  "aria-label": ariaLabel,
}: {
  /** Positioned host — usually the widget root (Pipelines provider). */
  hostRef: RefObject<HTMLElement | null>
  onClose: () => void
  children: ReactNode
  "aria-label"?: string
}) {
  const [box, setBox] = useState<HostBox | null>(null)

  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) {
      // Host missing — fall back to full viewport so the modal still opens.
      setBox({
        top: 0,
        left: 0,
        width: window.innerWidth,
        height: window.innerHeight,
      })
      return
    }

    function measure() {
      const el = hostRef.current
      if (!el) return
      const next = readHostBox(el)
      if (next.width < 8 || next.height < 8) {
        setBox({
          top: 0,
          left: 0,
          width: window.innerWidth,
          height: window.innerHeight,
        })
        return
      }
      setBox(next)
    }

    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(host)
    window.addEventListener("resize", measure)
    window.addEventListener("scroll", measure, true)
    return () => {
      ro.disconnect()
      window.removeEventListener("resize", measure)
      window.removeEventListener("scroll", measure, true)
    }
  }, [hostRef])

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

  if (!box) return null

  return createPortal(
    <div
      className="flex items-stretch justify-stretch bg-scrim-strong p-2 sm:p-2.5"
      style={{
        position: "fixed",
        top: box.top,
        left: box.left,
        width: box.width,
        height: box.height,
        zIndex: 80,
      }}
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
    </div>,
    document.body,
  )
}

/** Viewport-centered overlay (portal target body). */
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
