/**
 * Full-text bubble for truncated labels — Cursor-like orientation hint.
 * Only render when the label actually overflows.
 *
 * Placement flips to the side with room. Pinning `left: anchor.right` with no
 * flip leaves a 1-word-wide strip against the viewport edge (Threads runs).
 */

import type { CSSProperties, JSX } from "react"
import { createPortal } from "react-dom"

export function isTextTruncated(el: HTMLElement | null | undefined): boolean {
  if (!el) return false
  return el.scrollWidth > el.clientWidth + 1
}

const GAP = 10
const VIEWPORT_PAD = 8
/** Prefer at least this much horizontal room before flipping. */
const MIN_COMFORTABLE = 160
const PREFERRED_MAX_PX = 22 * 16

export type TruncationHintSide = "left" | "right"

export interface TruncationHintPlacement {
  side: TruncationHintSide
  top: number
  /** CSS `left` when side is right; omit when left. */
  left?: number
  /** CSS `right` when side is left; omit when right. */
  right?: number
  maxWidth: number
}

/**
 * Pick left/right from available space and cap width so the bubble never
 * collapses into a vertical strip against the viewport edge.
 */
export function placeTruncationHint(input: {
  anchor: Pick<DOMRect, "top" | "left" | "right" | "height">
  /** Soft preference when both sides fit. */
  prefer?: TruncationHintSide
  viewport?: { width: number; height: number }
}): TruncationHintPlacement {
  const prefer = input.prefer ?? "right"
  const vw = input.viewport?.width ?? (typeof window !== "undefined" ? window.innerWidth : 1280)
  const { anchor } = input

  const spaceRight = vw - anchor.right - GAP - VIEWPORT_PAD
  const spaceLeft = anchor.left - GAP - VIEWPORT_PAD

  let side: TruncationHintSide = prefer
  if (prefer === "right" && spaceRight < MIN_COMFORTABLE && spaceLeft > spaceRight) {
    side = "left"
  } else if (prefer === "left" && spaceLeft < MIN_COMFORTABLE && spaceRight > spaceLeft) {
    side = "right"
  }

  const available = side === "right" ? spaceRight : spaceLeft
  const maxWidth = Math.max(0, Math.min(PREFERRED_MAX_PX, available))

  const top = anchor.top + anchor.height / 2
  if (side === "right") {
    return { side, top, left: anchor.right + GAP, maxWidth }
  }
  return { side, top, right: vw - anchor.left + GAP, maxWidth }
}

export function TruncationHint({
  text,
  anchor,
  side: prefer = "right",
}: {
  text: string
  anchor: DOMRect
  /** Soft preference — flips when that side has no room. */
  side?: TruncationHintSide
}): JSX.Element {
  const placed = placeTruncationHint({
    anchor,
    prefer,
    viewport: { width: window.innerWidth, height: window.innerHeight },
  })

  const style: CSSProperties = {
    top: placed.top,
    maxWidth: placed.maxWidth,
    ...(placed.side === "right"
      ? { left: placed.left }
      : { right: placed.right }),
  }

  return createPortal(
    <div
      className={`truncation-hint${placed.side === "left" ? " truncation-hint--left" : ""}`}
      role="tooltip"
      style={style}
    >
      {text}
    </div>,
    document.body,
  )
}
