/**
 * VS Code–style sticky outline for Trace.
 *
 * In-flow headers are never position:sticky. A pin overlay renders the stack.
 *
 * Stick timing (critical): a scope pins the moment its top reaches the
 * *bottom of the current pin stack*, not bare scrollTop:
 *
 *   threshold = scrollTop + pinnedSoFar * ROW_H
 *   if scope.top <= threshold → pin it
 *
 * Using only `top <= scrollTop` sticks one (or more) rows late — the header
 * has already scrolled under the previous sticky row before we pin it.
 */

export const TRACE_STICKY_ROW_H = 34

export type TraceScopeKind = "context" | "call" | "sent" | "received"

export type TraceScopeEntry = {
  id: string
  kind: TraceScopeKind
  callIndex: number | null
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
    top: layoutOffsetInScroll(scrollEl, el),
    el,
  }))
}

/**
 * Pin scopes in document order as each reaches the bottom of the stack.
 * Pure — unit-tested without DOM sticky.
 */
export function computePinnedFromEntries(
  entries: Array<{ id: string; top: number }>,
  scrollTop: number,
  rowH: number = TRACE_STICKY_ROW_H,
): string[] {
  const pinned: string[] = []
  for (const e of entries) {
    // Stick when this header would be covered by (or flush with) the
    // already-pinned rows — not after several more pixels of scroll.
    const threshold = scrollTop + pinned.length * rowH
    if (e.top <= threshold + 0.5) {
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
  callIndex?: number
  sent?: boolean
  received?: boolean
} {
  if (scopeId === "context") return { preamble: true }

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
