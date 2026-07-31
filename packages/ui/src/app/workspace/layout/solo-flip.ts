/**
 * Solo maximize FLIP — keep the mature ease without animating width/height.
 *
 * Layout jumps to the final rect once (one reflow). Visual motion is a
 * compositor `transform` invert → identity, so expanded Trace/Chat are not
 * remeasured every animation frame.
 */

export type SoloFlipRect = {
  left: number
  top: number
  width: number
  height: number
}

export type SoloFlipFrom = SoloFlipRect & { tileId: string }

export const SOLO_FLIP_MS = 260

let pendingFrom: SoloFlipFrom | null = null

/** Capture tile geometry in canvas space before toggle re-renders. */
export function captureSoloFlipFrom(
  tileEl: HTMLElement,
  canvasEl: HTMLElement,
): void {
  const tileId = tileEl.dataset.tileId
  if (!tileId) {
    pendingFrom = null
    return
  }
  const t = tileEl.getBoundingClientRect()
  const c = canvasEl.getBoundingClientRect()
  pendingFrom = {
    tileId,
    left: t.left - c.left,
    top: t.top - c.top,
    width: t.width,
    height: t.height,
  }
}

export function takeSoloFlipFrom(): SoloFlipFrom | null {
  const next = pendingFrom
  pendingFrom = null
  return next
}

/** Clear without consuming (tests / aborted toggles). */
export function clearSoloFlipFrom(): void {
  pendingFrom = null
}

/**
 * Invert transform: element already at `to`, make it paint as `from`.
 * `transform-origin: 0 0` required.
 */
export function soloFlipInvertTransform(
  from: SoloFlipRect,
  to: SoloFlipRect,
): { dx: number; dy: number; sx: number; sy: number } | null {
  if (from.width < 1 || from.height < 1 || to.width < 1 || to.height < 1) {
    return null
  }
  if (
    Math.abs(from.left - to.left) < 0.5 &&
    Math.abs(from.top - to.top) < 0.5 &&
    Math.abs(from.width - to.width) < 0.5 &&
    Math.abs(from.height - to.height) < 0.5
  ) {
    return null
  }
  return {
    dx: from.left - to.left,
    dy: from.top - to.top,
    sx: from.width / to.width,
    sy: from.height / to.height,
  }
}

export function readTileRectInCanvas(
  tileEl: HTMLElement,
  canvasEl: HTMLElement,
): SoloFlipRect {
  const t = tileEl.getBoundingClientRect()
  const c = canvasEl.getBoundingClientRect()
  return {
    left: t.left - c.left,
    top: t.top - c.top,
    width: t.width,
    height: t.height,
  }
}
