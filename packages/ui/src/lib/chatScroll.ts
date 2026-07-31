/**
 * Chat / Trace scroll helpers — stick-to-bottom detection and anchor
 * preservation when expanding/collapsing rows without yanking the header.
 */

export const CHAT_SCROLL_HOST_ATTR = "data-chat-scroll-host"
export const TRACE_SCROLL_HOST_ATTR = "data-trace-scroll-host"

export function isNearBottom(el: HTMLElement, threshold = 120): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold
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
  return host instanceof HTMLDivElement ? host : null
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
 * Toggle expandable content without shifting the clicked control vertically.
 *
 * First principles:
 * - Header still on screen → only show/hide the body. Do not touch scrollTop.
 *   Multi-frame scroll correction fights VirtualList resize and makes the
 *   whole outline flinch like a reload.
 * - Scrolled into the body (header above the fold) → park on the header once
 *   after layout so the viewport is not left in the hole.
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
  toggle()
  if (!scrolledIntoBody || !scrollHost) return
  function park() {
    if (!scrollHost || !anchor.isConnected) return
    scrollHost.scrollTop = Math.max(
      0,
      offsetInScrollHost(scrollHost, anchor) - 2,
    )
  }
  // Commit unmount, then settle once more after pin overlay / measure.
  requestAnimationFrame(() => {
    park()
    requestAnimationFrame(park)
  })
}

/**
 * When the Trace pin band grows/shrinks, `.trace-scroll` `top` moves.
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
