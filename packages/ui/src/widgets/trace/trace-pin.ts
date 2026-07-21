/**
 * Cursor / VS Code sticky scroll for Trace.
 *
 * Only structural outline scopes pin (never per-message / per-tool rows —
 * those are leaf content and stacking them builds a broken tower).
 *
 *   Context | Call (0)
 *     Prompt | Tools | Sent | Received (1)
 *
 * In-flow headers stay in normal flow. A pin overlay paints the ancestor
 * chain of the focus line.
 *
 * Stick rule: pin after the header has scrolled *past* its stack slot
 * (top < threshold) while focus is still inside [top, end).
 * End = next same-or-shallower scope top.
 */

export const TRACE_STICKY_ROW_H = 34
export const TRACE_STICKY_MAX = 4

/** Kinds that participate in sticky scroll. */
export const TRACE_PIN_KINDS = new Set([
  "context",
  "prompt",
  "tools",
  "call",
  "sent",
  "received",
])

export type TraceScopeKind =
  | "context"
  | "prompt"
  | "tools"
  | "call"
  | "sent"
  | "received"
  | "message"
  | "tool"

export type TraceScopeEntry = {
  id: string
  kind: TraceScopeKind
  callIndex: number | null
  depth: number
  top: number
  el: HTMLElement
}

export function layoutOffsetInScroll(scrollEl: HTMLElement, el: HTMLElement): number {
  const s = scrollEl.getBoundingClientRect()
  const e = el.getBoundingClientRect()
  return e.top - s.top + scrollEl.scrollTop
}

/** Structural scope rows only — messages/tools are never pin candidates. */
export function listTraceScopes(scrollEl: HTMLElement): TraceScopeEntry[] {
  const nodes = [...scrollEl.querySelectorAll<HTMLElement>("[data-trace-scope]")]
  const out: TraceScopeEntry[] = []
  for (const el of nodes) {
    const kind = (el.dataset.traceKind ?? "call") as TraceScopeKind
    if (!TRACE_PIN_KINDS.has(kind)) continue
    out.push({
      id: el.dataset.traceScope!,
      kind,
      callIndex:
        el.dataset.traceCall == null || el.dataset.traceCall === ""
          ? null
          : Number(el.dataset.traceCall),
      depth: Number(el.dataset.traceDepth ?? "0") || 0,
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
  rowH: number = TRACE_STICKY_ROW_H,
  maxLines: number = TRACE_STICKY_MAX,
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

export function computePinnedScopeIds(scrollEl: HTMLElement): string[] {
  return computePinnedFromEntries(listTraceScopes(scrollEl), scrollEl.scrollTop)
}

export function samePinnedIds(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

export type ExpandPath = {
  preamble?: boolean
  contextPrompt?: boolean
  contextTools?: boolean
  callIndex?: number
  sent?: boolean
  received?: boolean
  messageKey?: string
  toolId?: string
}

export function expandPathForScope(scopeId: string): ExpandPath {
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

  const msgMatch = /^message:(\d+):m:(\d+)$/.exec(scopeId)
  if (msgMatch) {
    const callIndex = Number(msgMatch[1])
    const mi = msgMatch[2]!
    return {
      callIndex,
      sent: true,
      messageKey: `${callIndex}:m:${mi}`,
    }
  }

  const toolMatch = /^tool:(.+)$/.exec(scopeId)
  if (toolMatch) {
    return { toolId: toolMatch[1], received: true }
  }

  return {}
}

export function callIndexForTool(
  toolId: string,
  calls: Array<{ index: number; toolBranches: Array<{ id: string }> }>,
): number | undefined {
  for (const call of calls) {
    if (call.toolBranches.some((t) => t.id === toolId)) return call.index
  }
  return undefined
}
