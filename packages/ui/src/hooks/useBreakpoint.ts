/**
 * useBreakpoint — viewport-level responsive breakpoints (matches Tailwind defaults).
 *
 *   xs : <  640
 *   sm : >= 640
 *   md : >= 768
 *   lg : >= 1024
 *   xl : >= 1280
 *   2xl: >= 1536
 *
 * Use this for app-shell / chrome decisions (top toolbar, modal style, etc.).
 * For widget-internal layout, prefer `useContainerSize` instead.
 */

import { useEffect, useState } from "react"

export type Breakpoint = "xs" | "sm" | "md" | "lg" | "xl" | "2xl"

const BREAKPOINTS: Record<Exclude<Breakpoint, "xs">, number> = {
  sm: 640,
  md: 768,
  lg: 1024,
  xl: 1280,
  "2xl": 1536,
}

function compute(): Breakpoint {
  if (typeof window === "undefined") return "lg"
  const w = window.innerWidth
  if (w >= BREAKPOINTS["2xl"]) return "2xl"
  if (w >= BREAKPOINTS.xl) return "xl"
  if (w >= BREAKPOINTS.lg) return "lg"
  if (w >= BREAKPOINTS.md) return "md"
  if (w >= BREAKPOINTS.sm) return "sm"
  return "xs"
}

export function useBreakpoint(): Breakpoint {
  const [bp, setBp] = useState<Breakpoint>(compute)

  useEffect(() => {
    const handler = () => setBp(compute())
    window.addEventListener("resize", handler, { passive: true })
    return () => window.removeEventListener("resize", handler)
  }, [])

  return bp
}

/** Convenience: true when viewport is at least the named breakpoint. */
export function bpAtLeast(current: Breakpoint, target: Breakpoint): boolean {
  const order: Breakpoint[] = ["xs", "sm", "md", "lg", "xl", "2xl"]
  return order.indexOf(current) >= order.indexOf(target)
}
