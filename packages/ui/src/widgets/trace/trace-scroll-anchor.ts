/**
 * After More→Less, put the collapsed block back in view under the pin stack.
 *
 * Preserving raw scrollTop fails: a long expand leaves scrollTop huge, so
 * collapse lands you in later LLM calls. Sticky Less while deep in the text
 * has the same failure if we only keep the (off-screen) block top's Y.
 */

export function nearestTraceScroll(el: HTMLElement): HTMLElement | null {
  const found = el.closest(".trace-scroll")
  return found instanceof HTMLElement ? found : null
}

/** Pin stack height from the scrollport CSS var (px). */
export function readPinStackHeight(scrollEl: HTMLElement): number {
  const raw = scrollEl.style.getPropertyValue("--trace-pin-stack-h").trim()
  const n = parseFloat(raw)
  return Number.isFinite(n) ? n : 0
}

/**
 * Pure — scrollTop delta so `anchorTop` moves to `desiredTop` in the viewport.
 */
export function scrollDeltaToDesiredTop(
  anchorTop: number,
  desiredTop: number,
): number {
  return anchorTop - desiredTop
}

/**
 * Call immediately before collapsing. Returns a restore fn to run after
 * React has committed the smaller layout (double rAF).
 */
export function beginCollapseReveal(anchorEl: HTMLElement): () => void {
  const scrollEl = nearestTraceScroll(anchorEl)
  if (!scrollEl) return () => {}

  return function revealCollapsedAnchor() {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const pinH = readPinStackHeight(scrollEl)
        const scrollRect = scrollEl.getBoundingClientRect()
        const desiredTop = scrollRect.top + pinH + 6
        const delta = scrollDeltaToDesiredTop(
          anchorEl.getBoundingClientRect().top,
          desiredTop,
        )
        if (Math.abs(delta) > 0.5) {
          scrollEl.scrollTop += delta
        }
      })
    })
  }
}
