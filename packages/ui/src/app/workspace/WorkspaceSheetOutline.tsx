/**
 * Sheet silhouette: fill + stroke share one path (stage + active tab + scoops).
 * Fill sits under the stage so scoop pockets match the stroke exactly —
 * CSS tab/stage rects alone leave chrome wedges in the scoops.
 *
 * While reordering, the bump follows the active tab (or the active drag float)
 * every frame so the silhouette matches rest state.
 */

import { useLayoutEffect, useRef, useState, type JSX } from "react"
import { useLayoutStore } from "../../state/layout-store"
import {
  rectInHost,
  workspaceSheetOutlinePath,
  type SheetRect,
} from "../../lib/workspace-sheet-outline"

type OutlineState = {
  w: number
  h: number
  d: string
}

const EMPTY: OutlineState = { w: 0, h: 0, d: "" }

function readStageRadiusPx(stage: HTMLElement): number {
  const raw = getComputedStyle(stage).getPropertyValue("--stage-radius").trim()
  if (raw.endsWith("rem")) {
    const rem = Number.parseFloat(raw)
    if (Number.isFinite(rem)) {
      const root = Number.parseFloat(getComputedStyle(document.documentElement).fontSize)
      return rem * (Number.isFinite(root) ? root : 16)
    }
  }
  if (raw.endsWith("px")) {
    const px = Number.parseFloat(raw)
    if (Number.isFinite(px)) return px
  }
  return 16
}

/** Active tab chrome to attach the sheet bump to (resting or drag float). */
function findSheetTab(host: HTMLElement): HTMLElement | null {
  const strip = host.querySelector(".view-tab-strip")
  if (!strip) return null
  if (strip.hasAttribute("data-reordering")) {
    const floatActive = strip.querySelector<HTMLElement>(
      ".view-tab--float.view-tab--active",
    )
    if (floatActive) return floatActive
  }
  return host.querySelector<HTMLElement>(
    ".view-tab-strip .view-tab--active:not(.view-tab--float):not(.view-tab-dragging)",
  )
}

export function WorkspaceSheetOutline(): JSX.Element {
  const fillRef = useRef<SVGSVGElement>(null)
  const [outline, setOutline] = useState<OutlineState>(EMPTY)
  const activeViewId = useLayoutStore((s) => s.activeViewId)
  const views = useLayoutStore((s) => s.views)

  useLayoutEffect(() => {
    const chrome = fillRef.current?.closest<HTMLElement>(".workspace-chrome")
    if (!chrome) return

    let rafId = 0

    function measure() {
      const host = fillRef.current?.closest<HTMLElement>(".workspace-chrome")
      if (!host) return
      const stage = host.querySelector<HTMLElement>(".workspace-stage")
      if (!stage) {
        setOutline(EMPTY)
        return
      }

      const hostBox = host.getBoundingClientRect()
      const stageRect = rectInHost(hostBox, stage.getBoundingClientRect())
      const tabEl = findSheetTab(host)
      let tabRect: SheetRect | null = null
      if (tabEl) {
        const raw = rectInHost(hostBox, tabEl.getBoundingClientRect())
        tabRect = {
          ...raw,
          h: Math.max(1, stageRect.y - raw.y),
        }
      }

      setOutline({
        w: Math.max(1, Math.round(hostBox.width)),
        h: Math.max(1, Math.round(hostBox.height)),
        d: workspaceSheetOutlinePath(stageRect, tabRect, readStageRadiusPx(stage)),
      })
    }

    function pump() {
      measure()
      const strip = chrome.querySelector(".view-tab-strip")
      if (strip?.hasAttribute("data-reordering")) {
        rafId = requestAnimationFrame(pump)
      } else {
        rafId = 0
      }
    }

    function syncPump() {
      const strip = chrome.querySelector(".view-tab-strip")
      if (strip?.hasAttribute("data-reordering")) {
        if (!rafId) rafId = requestAnimationFrame(pump)
        return
      }
      if (rafId) {
        cancelAnimationFrame(rafId)
        rafId = 0
      }
      measure()
    }

    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(chrome)
    const stage = chrome.querySelector(".workspace-stage")
    if (stage) ro.observe(stage)
    const strip = chrome.querySelector(".view-tab-strip")
    const mo = new MutationObserver(syncPump)
    if (strip) {
      ro.observe(strip)
      strip.addEventListener("scroll", measure, { passive: true })
      mo.observe(strip, {
        attributes: true,
        childList: true,
        subtree: true,
        attributeFilter: ["data-reordering", "class", "style"],
      })
    }
    window.addEventListener("resize", measure, { passive: true })
    return () => {
      if (rafId) cancelAnimationFrame(rafId)
      ro.disconnect()
      mo.disconnect()
      strip?.removeEventListener("scroll", measure)
      window.removeEventListener("resize", measure)
    }
  }, [activeViewId, views])

  const viewBox = outline.w > 0 ? `0 0 ${outline.w} ${outline.h}` : undefined

  return (
    <>
      <svg
        ref={fillRef}
        className="workspace-sheet-fill"
        width={outline.w || "100%"}
        height={outline.h || "100%"}
        viewBox={viewBox}
        aria-hidden
      >
        {outline.d ? (
          <path d={outline.d} fill="var(--workspace-stage)" stroke="none" />
        ) : null}
      </svg>
      <svg
        className="workspace-sheet-outline"
        width={outline.w || "100%"}
        height={outline.h || "100%"}
        viewBox={viewBox}
        aria-hidden
      >
        {outline.d ? (
          <path
            d={outline.d}
            fill="none"
            stroke="var(--workspace-border)"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
      </svg>
    </>
  )
}
