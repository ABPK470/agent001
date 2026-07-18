/**
 * Viewport-aware placement for portaled menus / popovers.
 *
 * Prefer below the trigger; flip above when there is not enough room.
 * Clamp into the viewport so the panel stays fully visible.
 */

export type AnchoredPanelAlign = "start" | "end"
export type AnchoredPanelPlacement = "below" | "above"

export interface AnchoredRect {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

export interface PlaceAnchoredPanelInput {
  trigger: AnchoredRect
  panel: { width: number; height: number }
  /** Horizontal alignment to the trigger. Default `"end"` (right edges match). */
  align?: AnchoredPanelAlign
  gap?: number
  viewportPad?: number
  viewport?: { width: number; height: number }
}

export interface PlaceAnchoredPanelResult {
  top: number
  left: number
  placement: AnchoredPanelPlacement
}

const DEFAULT_GAP = 4
const DEFAULT_PAD = 8

export function placeAnchoredPanel(input: PlaceAnchoredPanelInput): PlaceAnchoredPanelResult {
  const gap = input.gap ?? DEFAULT_GAP
  const pad = input.viewportPad ?? DEFAULT_PAD
  const vw = input.viewport?.width ?? 1280
  const vh = input.viewport?.height ?? 800
  const { trigger, panel } = input
  const align = input.align ?? "end"

  const spaceBelow = vh - trigger.bottom - pad
  const spaceAbove = trigger.top - pad
  const placement: AnchoredPanelPlacement =
    spaceBelow < panel.height && spaceAbove > spaceBelow ? "above" : "below"

  let top =
    placement === "below"
      ? trigger.bottom + gap
      : trigger.top - gap - panel.height
  top = clamp(top, pad, Math.max(pad, vh - pad - panel.height))

  let left = align === "end" ? trigger.right - panel.width : trigger.left
  left = clamp(left, pad, Math.max(pad, vw - pad - panel.width))

  return {
    top: Math.round(top),
    left: Math.round(left),
    placement,
  }
}

/** DOMRect → plain rect (avoids live DOMRect mutation surprises). */
export function rectFromDom(el: Element): AnchoredRect {
  const r = el.getBoundingClientRect()
  return {
    left: r.left,
    top: r.top,
    right: r.right,
    bottom: r.bottom,
    width: r.width,
    height: r.height,
  }
}

export function placeAnchoredPanelForElements(
  triggerEl: Element,
  panelEl: Element | null,
  opts?: Omit<PlaceAnchoredPanelInput, "trigger" | "panel"> & {
    estimate?: { width: number; height: number }
  },
): PlaceAnchoredPanelResult {
  const trigger = rectFromDom(triggerEl)
  const panel = panelEl
    ? { width: panelEl.getBoundingClientRect().width, height: panelEl.getBoundingClientRect().height }
    : (opts?.estimate ?? { width: 160, height: 120 })
  return placeAnchoredPanel({
    trigger,
    panel,
    align: opts?.align,
    gap: opts?.gap,
    viewportPad: opts?.viewportPad,
    viewport: {
      width: typeof window !== "undefined" ? window.innerWidth : 1280,
      height: typeof window !== "undefined" ? window.innerHeight : 800,
    },
  })
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}
