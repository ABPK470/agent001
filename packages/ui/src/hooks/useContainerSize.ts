/**
 * useContainerSize — observe the rendered size of any element via ResizeObserver.
 *
 * Returns `{ width, height }` in CSS pixels. Updates on every resize, including
 * widget grid changes, parent flex reflows, and viewport changes.
 *
 * Usage:
 *   const ref = useRef<HTMLDivElement>(null)
 *   const { width } = useContainerSize(ref)
 *   const compact = width < 480
 */

import { useEffect, useState, type RefObject } from "react"

export interface ContainerSize {
  width: number
  height: number
}

export function useContainerSize(ref: RefObject<HTMLElement | null>): ContainerSize {
  const [size, setSize] = useState<ContainerSize>({ width: 0, height: 0 })

  useEffect(() => {
    const el = ref.current
    if (!el) return

    // Seed with current size before observer fires
    const rect = el.getBoundingClientRect()
    setSize({ width: rect.width, height: rect.height })

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const cr = entry.contentRect
        setSize({ width: cr.width, height: cr.height })
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])

  return size
}

/**
 * Container-query breakpoints — semantic widths for widget layout decisions.
 * These are in CSS pixels and apply to the *widget container*, not the viewport.
 */
export const WIDGET_BREAKPOINTS = {
  xs: 360,   // single-column, icon-only
  sm: 480,   // compact: icons + abbreviated labels
  md: 640,   // standard: full labels, dropdowns collapse
  lg: 900,   // comfortable: all controls inline
} as const

export type WidgetBreakpoint = keyof typeof WIDGET_BREAKPOINTS | "xl"

export function widgetBreakpoint(width: number): WidgetBreakpoint {
  if (width < WIDGET_BREAKPOINTS.xs) return "xs"
  if (width < WIDGET_BREAKPOINTS.sm) return "sm"
  if (width < WIDGET_BREAKPOINTS.md) return "md"
  if (width < WIDGET_BREAKPOINTS.lg) return "lg"
  return "xl"
}
