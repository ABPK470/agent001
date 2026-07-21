/**
 * Cursor / VS Code sticky-scroll pin algorithm for outline shells.
 *
 * In-flow headers stay in document flow. A pin overlay clones the ancestor
 * chain of the focus line (ViewSpec stickyFamilies / stickyTypes).
 *
 * Stick rule: pin after the header has scrolled *past* its stack slot
 * (top < threshold) while focus is still inside [top, end).
 * End = next same-or-shallower scope top.
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
): string[] {
  const ranged = withScopeEnds(entries)
  const pinned: string[] = []
  for (const e of ranged) {
    const threshold = scrollTop + pinned.length * rowH
    if (e.top < threshold - 0.5 && e.end > threshold + 0.5) {
      pinned.push(e.id)
    }
  }
  if (pinned.length <= maxLines) return pinned
  return pinned.slice(pinned.length - maxLines)
}

export function computePinnedScopeIds(
  scrollEl: HTMLElement,
  pinFamilies?: Set<string>,
): string[] {
  return computePinnedFromEntries(
    listOutlineScopes(scrollEl, pinFamilies),
    scrollEl.scrollTop,
  )
}

export function samePinnedIds(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}
