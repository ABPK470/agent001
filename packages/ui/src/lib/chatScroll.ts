/**
 * Chat / Trace scroll helpers — stick-to-bottom detection and anchor
 * preservation when expanding/collapsing rows without yanking the header.
 */

export const CHAT_SCROLL_HOST_ATTR = "data-chat-scroll-host"
export const TRACE_SCROLL_HOST_ATTR = "data-trace-scroll-host"
/** Expandable chip root — header + optional body share this ancestor. */
export const CHAT_EXPAND_ROOT_ATTR = "data-chat-expand-root"
/** Mounted body under an expand root (I/O pane, fold content, …). */
export const CHAT_EXPAND_BODY_ATTR = "data-chat-expand-body"

export function isNearBottom(el: HTMLElement, threshold = 120): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold
}

/**
 * Invisible floor anchor — neutralize a content height drop above the
 * viewport so streaming text below does not move on screen.
 * Δh = h_before − h_after (positive when content shrank).
 */
export function scrollTopAfterHeightShrink(scrollTop: number, deltaH: number): number {
  if (deltaH <= 0) return scrollTop
  return Math.max(0, scrollTop - deltaH)
}

export function scrollHostToBottom(host: HTMLElement, behavior: ScrollBehavior = "instant"): void {
  if (behavior === "smooth") {
    host.scrollTo({ top: host.scrollHeight, behavior: "smooth" })
  } else {
    host.scrollTop = host.scrollHeight
  }
}

export function findChatScrollHost(node: HTMLElement | null): HTMLDivElement | null {
  if (!node) return null
  const host = node.closest(
    `[${CHAT_SCROLL_HOST_ATTR}], [${TRACE_SCROLL_HOST_ATTR}]`,
  )
  return host ? (host as HTMLDivElement) : null
}

export function findExpandBody(anchor: HTMLElement): HTMLElement | null {
  const root = anchor.closest(`[${CHAT_EXPAND_ROOT_ATTR}]`)
  if (!root) return null
  const body = root.querySelector(`[${CHAT_EXPAND_BODY_ATTR}]`)
  if (!body || typeof (body as HTMLElement).getBoundingClientRect !== "function") {
    return null
  }
  const el = body as HTMLElement
  // ChatFoldBody keeps the node mounted at ~0 height when closed.
  if (el.getBoundingClientRect().height < 1) return null
  return el
}

/** Document Y of `el` within `scrollHost` (scrollTop space). */
export function offsetInScrollHost(scrollHost: HTMLElement, el: HTMLElement): number {
  const s = scrollHost.getBoundingClientRect()
  const e = el.getBoundingClientRect()
  return e.top - s.top + scrollHost.scrollTop
}

/**
 * After collapsing a long body, park the viewport on that scope's header.
 * Overlay pins (`stackInScroll: true`) need stack height subtracted so the
 * header lands below the pin chrome. Reserved-band pins leave stack at 0.
 */
export function parkScrollOnScope(
  scrollHost: HTMLElement,
  scopeEl: HTMLElement,
  rowH: number,
  pinnedIds: (host: HTMLElement) => string[],
  opts: { stackInScroll?: boolean } = {},
): void {
  const stackInScroll = opts.stackInScroll === true
  scrollHost.scrollTop = Math.max(0, offsetInScrollHost(scrollHost, scopeEl) - 2)
  for (let i = 0; i < 4; i++) {
    const stackH = stackInScroll ? pinnedIds(scrollHost).length * rowH : 0
    const top = offsetInScrollHost(scrollHost, scopeEl)
    const next = Math.max(0, top - stackH - 2)
    if (Math.abs(next - scrollHost.scrollTop) < 1) break
    scrollHost.scrollTop = next
  }
}

/**
 * Header still intersects the scrollport → fold is show/hide only.
 * Header above the fold (scrolled into body) → park after layout.
 */
export function shouldParkAfterToggle(scrollTop: number, headerDoc: number): boolean {
  return scrollTop > headerDoc + 1
}

/**
 * Minimal scrollTop delta so `el` intersects the viewport (nearest).
 * Prefers keeping the top of a tall body visible over chasing its bottom.
 */
export function nearestRevealScrollDelta(
  elTop: number,
  elBottom: number,
  viewTop: number,
  viewBottom: number,
  padding = 12,
): number {
  if (elTop >= viewTop + padding && elBottom <= viewBottom - padding) return 0

  let delta = 0
  if (elBottom > viewBottom - padding) {
    delta = elBottom - (viewBottom - padding)
  }
  const newTop = elTop - delta
  if (newTop < viewTop + padding) {
    delta = elTop - (viewTop + padding)
  }
  return delta
}

/**
 * Scroll overflowing ancestors (tool-chain list → chat host) just enough
 * that `el` enters each viewport — expand "makes space" without a hard jump.
 */
export function revealElementInScrollAncestors(
  el: HTMLElement,
  stopAt: HTMLElement | null = null,
  padding = 12,
): void {
  for (let pass = 0; pass < 6; pass++) {
    let adjusted = false
    let node: HTMLElement | null = el.parentElement
    while (node) {
        const style = globalThis.getComputedStyle(node)
      const overflowY = style.overflowY
      if (
        (overflowY === "auto" || overflowY === "scroll") &&
        node.scrollHeight > node.clientHeight + 1
      ) {
        const parentRect = node.getBoundingClientRect()
        const elRect = el.getBoundingClientRect()
        const delta = nearestRevealScrollDelta(
          elRect.top,
          elRect.bottom,
          parentRect.top,
          parentRect.bottom,
          padding,
        )
        if (Math.abs(delta) >= 1) {
          node.scrollTop += delta
          adjusted = true
        }
      }
      if (stopAt && node === stopAt) break
      node = node.parentElement
    }
    if (!adjusted) break
  }
}

/**
 * Toggle expandable content without shifting the clicked control vertically.
 *
 * - Collapse while scrolled into the body → park on the header.
 * - Expand → after layout, minimally reveal the new body in nested scroll
 *   ancestors (tool-chain list + transcript host).
 * - Header still on screen and no reveal needed → do not flinch scrollTop.
 */
export function preserveScrollAnchor(
  button: HTMLElement | null,
  toggle: () => void,
  onEngage?: () => void,
): void {
  onEngage?.()
  if (!button) {
    toggle()
    return
  }
  const anchor = button
  const scrollHost = findChatScrollHost(anchor)
  const headerDoc = scrollHost ? offsetInScrollHost(scrollHost, anchor) : 0
  const scrolledIntoBody = Boolean(
    scrollHost && shouldParkAfterToggle(scrollHost.scrollTop, headerDoc),
  )
  const hadBody = Boolean(findExpandBody(anchor))
  toggle()

  function afterLayout() {
    if (!anchor.isConnected) return
    if (scrolledIntoBody && hadBody && scrollHost) {
      scrollHost.scrollTop = Math.max(
        0,
        offsetInScrollHost(scrollHost, anchor) - 2,
      )
      return
    }
    if (!hadBody) {
      const body = findExpandBody(anchor)
      if (body) revealElementInScrollAncestors(body, scrollHost)
    }
  }

  // Commit mount/unmount, then settle once more after fold / measure.
  requestAnimationFrame(() => {
    afterLayout()
    requestAnimationFrame(afterLayout)
  })
}

/**
 * Reserved-band pins: `.trace-scroll` `top` moves with stack height.
 * Shift scrollTop by the same delta so document content stays put on screen.
 */
export function compensatePinBandInset(
  scrollHost: HTMLElement,
  nextStackH: number,
  cssVar = "--trace-pin-stack-h",
): void {
  const prevRaw = scrollHost.style.getPropertyValue(cssVar).trim()
  const prevH = prevRaw.endsWith("px") ? Number.parseFloat(prevRaw) : Number.parseFloat(prevRaw)
  const from = Number.isFinite(prevH) ? prevH : 0
  if (from === nextStackH) return
  scrollHost.style.setProperty(cssVar, `${nextStackH}px`)
  scrollHost.scrollTop = Math.max(0, scrollHost.scrollTop + (nextStackH - from))
}
