/**
 * Chat scroll helpers — stick-to-bottom detection and anchor preservation
 * when expanding/collapsing trace rows without yanking the viewport.
 */

export const CHAT_SCROLL_HOST_ATTR = "data-chat-scroll-host"

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
  const host = node.closest(`[${CHAT_SCROLL_HOST_ATTR}]`)
  return host instanceof HTMLDivElement ? host : null
}

/**
 * Toggle expandable content without shifting the clicked control vertically.
 * Optionally pauses parent autoscroll so live generation does not snap back
 * to the bottom while the user inspects a row.
 */
export function preserveScrollAnchor(
  button: HTMLButtonElement | null,
  toggle: () => void,
  onEngage?: () => void,
): void {
  onEngage?.()
  if (!button) {
    toggle()
    return
  }
  const scrollHost = findChatScrollHost(button)
  const beforeTop = button.getBoundingClientRect().top
  toggle()
  requestAnimationFrame(() => {
    if (!scrollHost || !button.isConnected) return
    const afterTop = button.getBoundingClientRect().top
    scrollHost.scrollTop += afterTop - beforeTop
  })
}
