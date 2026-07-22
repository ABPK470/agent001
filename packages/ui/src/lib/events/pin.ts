/**
 * Cursor / VS Code sticky-scroll pin algorithm for outline shells.
 *
 * In-flow headers stay in document flow. A pin band (Trace) or overlay
 * (OutlineTree) clones the ancestor chain of the focus line
 * (ViewSpec stickyFamilies / stickyTypes).
 *
 * Stick rule: pin after the header has scrolled *fully past* the focus line
 * while focus is still inside [top, end). End = next same-or-shallower scope top.
 *
 * `stackInScroll` (Outline overlay): focus line steps down by one row per
 * already-pinned ancestor — pins eat into the scrollport.
 * `stackInScroll: false` (Trace reserved band): focus line is always the
 * scrollport top — pins live outside and must not inflate the threshold
 * (early stick = blank gap under the band; early yield = pin vanishes too soon).
 */

export const OUTLINE_STICKY_ROW_H = 34
export const OUTLINE_STICKY_MAX = 4

/** Default structural families eligible for pin (Trace dialect). */
export const OUTLINE_PIN_FAMILIES = new Set([
  "context",
  "prompt",
  "tools",
  "call",
  "sent",
  "received",
  "phase",
  "work",
  "plan",
  "pipeline",
  "step",
  "verify",
  "repair",
  "message",
])

export type OutlineScopeEntry = {
  id: string
  family: string
  depth: number
  top: number
  el: HTMLElement
}

export function layoutOffsetInScroll(scrollEl: HTMLElement, el: HTMLElement): number {
  const s = scrollEl.getBoundingClientRect()
  const e = el.getBoundingClientRect()
  return e.top - s.top + scrollEl.scrollTop
}

/**
 * List pin-eligible scopes in a scroll host.
 * Prefer `[data-outline-scope]`; fall back to `[data-trace-scope]` for Trace.
 */
export function listOutlineScopes(
  scrollEl: HTMLElement,
  pinFamilies: Set<string> = OUTLINE_PIN_FAMILIES,
): OutlineScopeEntry[] {
  const nodes = [
    ...scrollEl.querySelectorAll<HTMLElement>("[data-outline-scope], [data-trace-scope]"),
  ]
  const out: OutlineScopeEntry[] = []
  for (const el of nodes) {
    const id = el.dataset.outlineScope ?? el.dataset.traceScope
    if (!id) continue
    const family =
      el.dataset.outlineFamily ??
      el.dataset.traceKind ??
      "call"
    if (!pinFamilies.has(family)) continue
    out.push({
      id,
      family,
      depth: Number(el.dataset.outlineDepth ?? el.dataset.traceDepth ?? "0") || 0,
      top: layoutOffsetInScroll(scrollEl, el),
      el,
    })
  }
  return out
}

export type PinEntry = {
  id: string
  top: number
  depth: number
}

export type PinComputeOpts = {
  /**
   * When true (Outline overlay), each pinned row shifts the focus line down
   * inside the scrollport. When false (Trace band), focus is always scrollTop.
   */
  stackInScroll?: boolean
}

export function withScopeEnds(
  entries: PinEntry[],
): Array<PinEntry & { end: number }> {
  return entries.map((e, i) => {
    let end = Number.POSITIVE_INFINITY
    for (let j = i + 1; j < entries.length; j++) {
      if (entries[j]!.depth <= e.depth) {
        end = entries[j]!.top
        break
      }
    }
    return { ...e, end }
  })
}

export function computePinnedFromEntries(
  entries: PinEntry[],
  scrollTop: number,
  rowH: number = OUTLINE_STICKY_ROW_H,
  maxLines: number = OUTLINE_STICKY_MAX,
  opts: PinComputeOpts = {},
): string[] {
  // Default true preserves Outline overlay + existing unit contracts.
  const stackInScroll = opts.stackInScroll !== false
  const ranged = withScopeEnds(entries)
  const pinned: string[] = []
  for (const e of ranged) {
    const threshold = stackInScroll
      ? scrollTop + pinned.length * rowH
      : scrollTop
    // Stick only after the header has fully cleared the focus line…
    const pastHeader = e.top + rowH < threshold - 0.5
    // …and yield when the next same-or-shallower header reaches the focus
    // line (overlay: +rowH so peers are not covered under the stack).
    const yieldPad = stackInScroll ? rowH : 0
    const nextHeaderClear = e.end > threshold + yieldPad + 0.5
    if (pastHeader && nextHeaderClear) {
      pinned.push(e.id)
    }
  }
  if (pinned.length <= maxLines) return pinned
  return pinned.slice(pinned.length - maxLines)
}

export function computePinnedScopeIds(
  scrollEl: HTMLElement,
  pinFamilies?: Set<string>,
  opts?: PinComputeOpts,
): string[] {
  return computePinnedFromEntries(
    listOutlineScopes(scrollEl, pinFamilies),
    scrollEl.scrollTop,
    OUTLINE_STICKY_ROW_H,
    OUTLINE_STICKY_MAX,
    opts,
  )
}

export function samePinnedIds(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/**
 * Replace contract: hide in-flow headers that are currently pinned so the
 * pin band does not double-paint them. Optionally reserve scroll-padding
 * when the pin paints as an in-scroll overlay (OutlineTree).
 */
export function syncPinnedInFlow(
  host: HTMLElement,
  pinnedIds: string[],
  rowH: number = OUTLINE_STICKY_ROW_H,
  opts: { reserveScrollPadding?: boolean } = {},
): void {
  const reserveScrollPadding = opts.reserveScrollPadding !== false
  for (const el of host.querySelectorAll<HTMLElement>(
    "[data-outline-pinned], [data-trace-pinned]",
  )) {
    el.removeAttribute("data-outline-pinned")
    el.removeAttribute("data-trace-pinned")
  }
  for (const id of pinnedIds) {
    const escaped = CSS.escape(id)
    const el = host.querySelector<HTMLElement>(
      `[data-outline-scope="${escaped}"], [data-trace-scope="${escaped}"]`,
    )
    if (!el) continue
    if (el.hasAttribute("data-outline-scope")) el.setAttribute("data-outline-pinned", "")
    if (el.hasAttribute("data-trace-scope")) el.setAttribute("data-trace-pinned", "")
  }
  if (!reserveScrollPadding) {
    host.style.scrollPaddingTop = ""
    return
  }
  host.style.scrollPaddingTop =
    pinnedIds.length > 0 ? `${pinnedIds.length * rowH}px` : ""
}
