/**
 * VS Code–style sticky outline for Trace.
 *
 * In-flow headers are never position:sticky. A pin overlay renders the stack.
 *
 * Stick rule (matches editor sticky scroll): a scope pins only while the
 * focus line is *inside* that scope — [top, end). Leaving a block unsticks
 * it (siblings don’t accumulate). End = next same-or-shallower scope top.
 *
 * Stick timing: threshold = scrollTop + pinnedSoFar * ROW_H so a child
 * pins as soon as it reaches the bottom of the current stack.
 */

export const TRACE_STICKY_ROW_H = 34

export type TraceScopeKind =
  | "context"
  | "prompt"
  | "tools"
  | "call"
  | "sent"
  | "received"

export type TraceScopeEntry = {
  id: string
  kind: TraceScopeKind
  callIndex: number | null
  depth: number
  /** Layout Y in scroll content (normal flow). */
  top: number
  el: HTMLElement
}

/**
 * Layout Y of `el` within `scrollEl` content.
 * Headers must not be sticky when this runs (overlay model — always true).
 */
export function layoutOffsetInScroll(scrollEl: HTMLElement, el: HTMLElement): number {
  const s = scrollEl.getBoundingClientRect()
  const e = el.getBoundingClientRect()
  return e.top - s.top + scrollEl.scrollTop
}

/** Read all scope rows and their layout tops. */
export function listTraceScopes(scrollEl: HTMLElement): TraceScopeEntry[] {
  const nodes = [...scrollEl.querySelectorAll<HTMLElement>("[data-trace-scope]")]
  return nodes.map((el) => ({
    id: el.dataset.traceScope!,
    kind: (el.dataset.traceKind ?? "call") as TraceScopeKind,
    callIndex:
      el.dataset.traceCall == null || el.dataset.traceCall === ""
        ? null
        : Number(el.dataset.traceCall),
    depth: Number(el.dataset.traceDepth ?? "0") || 0,
    top: layoutOffsetInScroll(scrollEl, el),
    el,
  }))
}

export type PinEntry = {
  id: string
  top: number
  depth: number
}

/** End Y of each scope = top of next same-or-shallower scope (or +Infinity). */
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

/**
 * Pin scopes that still contain the focus line (VS Code sticky scroll).
 * Pure — unit-tested without DOM sticky.
 */
export function computePinnedFromEntries(
  entries: PinEntry[],
  scrollTop: number,
  rowH: number = TRACE_STICKY_ROW_H,
): string[] {
  const ranged = withScopeEnds(entries)
  const pinned: string[] = []
  for (const e of ranged) {
    const threshold = scrollTop + pinned.length * rowH
    if (e.top <= threshold + 0.5 && e.end > threshold + 0.5) {
      pinned.push(e.id)
    }
  }
  return pinned
}

export function computePinnedScopeIds(scrollEl: HTMLElement): string[] {
  return computePinnedFromEntries(listTraceScopes(scrollEl), scrollEl.scrollTop)
}

/**
 * Ancestors to expand so `scopeId` is in the DOM / reachable.
 */
export function expandPathForScope(scopeId: string): {
  preamble?: boolean
  contextPrompt?: boolean
  contextTools?: boolean
  callIndex?: number
  sent?: boolean
  received?: boolean
} {
  if (scopeId === "context") return { preamble: true }
  if (scopeId === "prompt") return { preamble: true, contextPrompt: true }
  if (scopeId === "tools") return { preamble: true, contextTools: true }

  const callMatch = /^call:(\d+)$/.exec(scopeId)
  if (callMatch) return { callIndex: Number(callMatch[1]) }

  const sentMatch = /^sent:(\d+)$/.exec(scopeId)
  if (sentMatch) {
    return { callIndex: Number(sentMatch[1]), sent: true }
  }

  const recvMatch = /^received:(\d+)$/.exec(scopeId)
  if (recvMatch) {
    return { callIndex: Number(recvMatch[1]), received: true }
  }

  return {}
}
