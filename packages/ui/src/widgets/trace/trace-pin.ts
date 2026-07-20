/**
 * VS Code–style sticky outline for Trace.
 *
 * In-flow headers are never position:sticky. A separate pin overlay renders
 * the active stack. Pin decisions use layout tops measured while nothing is
 * sticky — no feedback loop / flicker.
 *
 * Stack model (outer scopes):
 *   - every Context / Call whose flow-top has scrolled past stays pinned
 *   - Sent / Received of the *current* (last) Call pin under it when past
 *
 * Click (handled in the view): reveal that scope — expand ancestors + scroll
 * so its header sits under the pin stack.
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
 * Headers must not be sticky when this runs.
 */
export function layoutOffsetInScroll(scrollEl: HTMLElement, el: HTMLElement): number {
  const s = scrollEl.getBoundingClientRect()
  const e = el.getBoundingClientRect()
  return e.top - s.top + scrollEl.scrollTop
}

/** Read all scope rows and their layout tops (sticky must be off — always true for overlay model). */
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
 * Which scopes belong in the pin stack for `scrollTop`.
 * Pure over a measured entry list — unit-tested without DOM sticky.
 */
export function computePinnedFromEntries(
  entries: Array<Omit<TraceScopeEntry, "el"> & { el?: HTMLElement }>,
  scrollTop: number,
): string[] {
  if (entries.length === 0) return []

  const pinned: typeof entries = []
  for (const e of entries) {
    if (e.kind === "context" || e.kind === "call") {
      if (e.top <= scrollTop + 0.5) pinned.push(e)
    }
  }

  let currentCall: number | null = null
  for (let i = pinned.length - 1; i >= 0; i--) {
    const hit = pinned[i]!
    if (hit.kind === "call" && hit.callIndex != null) {
      currentCall = hit.callIndex
      break
    }
  }

  if (currentCall != null) {
    for (const e of entries) {
      if (e.callIndex !== currentCall) continue
      if (e.kind !== "sent" && e.kind !== "received") continue
      if (e.top <= scrollTop + 0.5) pinned.push(e)
    }
  }

  return pinned.map((e) => e.id)
}

export function computePinnedScopeIds(scrollEl: HTMLElement): string[] {
  return computePinnedFromEntries(listTraceScopes(scrollEl), scrollEl.scrollTop)
}

/**
 * Ancestors to expand so `scopeId` is reachable in the tree.
 * Order: context (if needed) → call → sent/received.
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
