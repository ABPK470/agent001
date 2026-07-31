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
 * Trace pins sit outside the scrollport — park on the header with no stack offset.
 * Pass `stackInScroll: true` only for overlays that paint inside the scroll host.
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
 * Toggle expandable content without shifting the clicked control vertically.
 * Header stays put; body opens downward (or collapses upward into it).
 *
 * If the user had scrolled *into* the body (header above the viewport),
 * collapse parks on the header instead of leaving scrollTop in the hole.
 *
 * Settle in a few frames (commit → measure → pin inset). A long rAF loop
 * fights VirtualList resize correction and feels like the outline reloads.
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
  const beforeTop = anchor.getBoundingClientRect().top
  const headerDoc = scrollHost ? offsetInScrollHost(scrollHost, anchor) : 0
  const scrolledIntoBody = Boolean(
    scrollHost && scrollHost.scrollTop > headerDoc + 1,
  )
  toggle()
  function adjust() {
    if (!scrollHost || !anchor.isConnected) return
    if (scrolledIntoBody) {
      // Trace pin band is outside the scrollport — do not subtract stack height.
      scrollHost.scrollTop = Math.max(
        0,
        offsetInScrollHost(scrollHost, anchor) - 2,
      )
      return
    }
    const afterTop = anchor.getBoundingClientRect().top
    const delta = afterTop - beforeTop
    if (delta !== 0) scrollHost.scrollTop += delta
  }
  let frames = 0
  function tick() {
    adjust()
    frames += 1
    if (frames < 3) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}
