/**
 * Horizontal split-pane drag — flat peer handlers + explicit drag ref.
 */

import type { PointerEvent as ReactPointerEvent } from "react"

export type SplitPaneDragState = {
  pointerId: number
  startX: number
  startRatio: number
  containerWidth: number
}

export function clampSplitRatio(ratio: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, ratio))
}

export function beginSplitPaneDrag(
  event: React.PointerEvent<HTMLElement>,
  container: HTMLElement,
  currentRatio: number,
): SplitPaneDragState | null {
  if (event.button !== 0) return null
  event.preventDefault()
  event.currentTarget.setPointerCapture(event.pointerId)
  return {
    pointerId: event.pointerId,
    startX: event.clientX,
    startRatio: currentRatio,
    containerWidth: Math.max(1, container.clientWidth),
  }
}

export function moveSplitPaneDrag(
  drag: SplitPaneDragState,
  event: React.PointerEvent<HTMLElement>,
  minRatio: number,
  maxRatio: number,
): number {
  const deltaRatio = (event.clientX - drag.startX) / drag.containerWidth
  return clampSplitRatio(drag.startRatio + deltaRatio, minRatio, maxRatio)
}

export function endSplitPaneDrag(
  drag: SplitPaneDragState | null,
  event: React.PointerEvent<HTMLElement>,
): void {
  if (!drag || event.pointerId !== drag.pointerId) return
  try {
    event.currentTarget.releasePointerCapture(drag.pointerId)
  } catch {
    /* capture already released */
  }
}
