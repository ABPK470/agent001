/**
 * Full-text bubble for truncated labels — Cursor-like orientation hint.
 * Only render when the label actually overflows.
 */

import { createPortal } from "react-dom"

export function isTextTruncated(el: HTMLElement | null | undefined): boolean {
  if (!el) return false
  return el.scrollWidth > el.clientWidth + 1
}

export function TruncationHint({
  text,
  anchor,
  side = "right",
}: {
  text: string
  anchor: DOMRect
  /** Prefer `left` when the trigger sits on the right edge of the viewport. */
  side?: "left" | "right"
}) {
  const style =
    side === "right"
      ? {
          top: anchor.top + anchor.height / 2,
          left: anchor.right + 10,
        }
      : {
          top: anchor.top + anchor.height / 2,
          right: window.innerWidth - anchor.left + 10,
        }

  return createPortal(
    <div
      className={`truncation-hint${side === "left" ? " truncation-hint--left" : ""}`}
      role="tooltip"
      style={style}
    >
      {text}
    </div>,
    document.body,
  )
}
