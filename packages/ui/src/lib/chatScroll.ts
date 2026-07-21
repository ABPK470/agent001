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
 * After collapsing a long body, park the viewport on that scope's header
 * (accounting for a sticky pin stack above it). Without this, scrollTop
 * still points into the removed body and lands on unrelated later content.
 */
export function parkScrollOnScope(
  scrollHost: HTMLElement,
  scopeEl: HTMLElement,
  rowH: number,
  pinnedIds: (host: HTMLElement) => string[],
): void {
  scrollHost.scrollTop = Math.max(0, offsetInScrollHost(scrollHost, scopeEl) - 2)
  for (let i = 0; i < 4; i++) {
    const stackH = pinnedIds(scrollHost).length * rowH
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
      const stackH =
        Number.parseFloat(scrollHost.style.getPropertyValue("--trace-pin-stack-h")) || 0
      scrollHost.scrollTop = Math.max(
        0,
        offsetInScrollHost(scrollHost, anchor) - stackH - 2,
      )
      return
    }
    const afterTop = anchor.getBoundingClientRect().top
    const delta = afterTop - beforeTop
    if (delta !== 0) scrollHost.scrollTop += delta
  }
  // First frame: React commit. Second: sticky / nest layout settled.
  requestAnimationFrame(() => {
    adjust()
    requestAnimationFrame(adjust)
  })
}
