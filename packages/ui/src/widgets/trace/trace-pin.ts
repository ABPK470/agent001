/**
 * VS Code–style sticky outline for Trace.
 *
 * In-flow headers are never position:sticky. A pin overlay renders the stack.
 *
 * Stack rule (document order): every scope whose layout top has scrolled past
 * `scrollTop` stays pinned — Context, Call 1, Sent, Received, Call 2, Sent…
 * Previous siblings unstick only when you scroll back above them.
 *
 * That way Call 2 always appears between Call 1’s Received and Call 2’s Sent.
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
 * Pin every scope scrolled past, in document order.
 * Pure — unit-tested without DOM sticky.
 */
export function computePinnedFromEntries(
  entries: Array<{ id: string; top: number }>,
  scrollTop: number,
): string[] {
  return entries.filter((e) => e.top <= scrollTop + 0.5).map((e) => e.id)
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
