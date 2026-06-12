import { useEffect, useState } from "react"
import { computeThreadRailFits } from "./threadRailLayout"

function readViewportWidth(): number {
  if (typeof window === "undefined") return 1280
  return window.innerWidth
}

function readRootFontPx(): number {
  if (typeof document === "undefined") return 16
  const px = parseFloat(getComputedStyle(document.documentElement).fontSize)
  return Number.isFinite(px) ? px : 16
}

export function useThreadRailLayout(): {
  viewportWidth: number
  railFits: boolean
} {
  const [viewportWidth, setViewportWidth] = useState(readViewportWidth)
  const [rootFontPx, setRootFontPx] = useState(readRootFontPx)

  useEffect(() => {
    const onResize = () => {
      setViewportWidth(window.innerWidth)
      setRootFontPx(readRootFontPx())
    }
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [])

  return {
    viewportWidth,
    railFits: computeThreadRailFits(viewportWidth, rootFontPx),
  }
}
