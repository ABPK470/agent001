/**
 * Trace pin helpers — thin façade over lib/events/pin + Trace expand paths.
 */

import {
  OUTLINE_PIN_FAMILIES,
  OUTLINE_STICKY_MAX,
  OUTLINE_STICKY_ROW_H,
  computePinnedFromEntries,
  computePinnedScopeIds,
  layoutOffsetInScroll,
  withScopeEnds,
} from "../../lib/events/pin"

export {
  OUTLINE_STICKY_ROW_H as TRACE_STICKY_ROW_H,
  OUTLINE_STICKY_MAX as TRACE_STICKY_MAX,
  OUTLINE_PIN_FAMILIES as TRACE_PIN_KINDS,
  layoutOffsetInScroll,
  withScopeEnds,
  computePinnedFromEntries,
  computePinnedScopeIds,
  samePinnedIds,
  syncPinnedInFlow,
  type PinEntry,
  type PinComputeOpts,
} from "../../lib/events/pin"

/**
 * Trace reserved-band pin math — focus line is the scrollport top.
 * Pins live in a sibling band above `.trace-scroll` (Cursor / VS Code dialect)
 * so content never paints under the stack. Band height changes are
 * compensated in TraceDag via `stabilizePinBandScrollTop`.
 */
export const TRACE_PIN_OPTS = { stackInScroll: false } as const

export type TraceScopeLayout = {
  id: string
  top: number
  height: number
  depth: number
  open?: boolean
}

/**
 * Sync live headers into the pin layout cache.
 *
 * Must record collapsed rows (`open: false`) — previously we only wrote open
 * scopes from `listOutlineScopes`, so fold left stale `open: true` entries and
 * the overlay kept pinning Context/Prompt with nothing expanded.
 *
 * Children of a collapsed parent leave the DOM; drop them from the cache so
 * they cannot pin as orphans.
 *
 * VirtualList-unmounted rows stay only when they are *ancestors of a mounted
 * scope* (Cursor sticky-scroll dialect). Peer ghosts (Call 7 / SENT after you
 * have scrolled on to Pipeline + Subagent) must not linger — stale tops +
 * end=∞ kept pinning them while the focus line was elsewhere.
 */
export function syncTracePinLayoutCache(
  scrollEl: HTMLElement,
  layoutCache: Map<string, TraceScopeLayout>,
): void {
  const nodes = [
    ...scrollEl.querySelectorAll<HTMLElement>("[data-outline-scope], [data-trace-scope]"),
  ]
  const mountedIds = new Set<string>()
  for (const el of nodes) {
    const id = el.dataset.outlineScope ?? el.dataset.traceScope
    if (!id) continue
    const family = el.dataset.outlineFamily ?? el.dataset.traceKind ?? "call"
    if (!OUTLINE_PIN_FAMILIES.has(family)) continue
    if (el.classList.contains("is-leaf")) {
      layoutCache.delete(id)
      continue
    }
    const open = el.getAttribute("aria-expanded") !== "false"
    mountedIds.add(id)
    layoutCache.set(id, {
      id,
      top: layoutOffsetInScroll(scrollEl, el),
      height: Math.max(
        1,
        el.getBoundingClientRect().height || el.offsetHeight || OUTLINE_STICKY_ROW_H,
      ),
      depth: Number(el.dataset.outlineDepth ?? el.dataset.traceDepth ?? "0") || 0,
      open,
    })
  }

  const closed = [...layoutCache.values()].filter((e) => e.open === false)
  if (closed.length > 0) {
    const ordered = [...layoutCache.values()].sort(
      (a, b) => a.top - b.top || a.depth - b.depth,
    )
    const endById = new Map(withScopeEnds(ordered).map((e) => [e.id, e.end]))
    for (const parent of closed) {
      const end = endById.get(parent.id) ?? Number.POSITIVE_INFINITY
      for (const [id, e] of [...layoutCache.entries()]) {
        if (id === parent.id) continue
        if (e.depth > parent.depth && e.top >= parent.top && e.top < end) {
          layoutCache.delete(id)
        }
      }
    }
  }

  pruneTracePinLayoutCacheToMountedLineage(layoutCache, mountedIds)
}

/**
 * Cursor sticky-scroll: keep only mounted scopes + their enclosing ancestors.
 * Drop peer / cousin ghosts left by VirtualList unmount (wrong Call/SENT pins).
 */
export function pruneTracePinLayoutCacheToMountedLineage(
  layoutCache: Map<string, TraceScopeLayout>,
  mountedIds: ReadonlySet<string>,
): void {
  if (layoutCache.size === 0) return
  if (mountedIds.size === 0) {
    layoutCache.clear()
    return
  }
  const ordered = [...layoutCache.values()].sort(
    (a, b) => a.top - b.top || a.depth - b.depth,
  )
  const ranged = withScopeEnds(ordered)
  const keep = new Set<string>(mountedIds)
  for (const m of ranged) {
    if (!mountedIds.has(m.id)) continue
    for (const a of ranged) {
      if (a.id === m.id) continue
      if (a.open === false) continue
      if (a.depth < m.depth && a.top <= m.top && m.top < a.end) {
        keep.add(a.id)
      }
    }
  }
  for (const id of [...layoutCache.keys()]) {
    if (!keep.has(id)) layoutCache.delete(id)
  }
}

/**
 * Pin from mounted scopes, merging into `layoutCache` so VirtualList-unmounted
 * *ancestors* above the window still stick. Peer ghosts are pruned each pass.
 */
export function computeTracePinnedScopeIds(
  scrollEl: HTMLElement,
  layoutCache?: Map<string, TraceScopeLayout>,
): string[] {
  if (layoutCache) {
    syncTracePinLayoutCache(scrollEl, layoutCache)
    const entries = [...layoutCache.values()].sort(
      (a, b) => a.top - b.top || a.depth - b.depth,
    )
    return computePinnedFromEntries(
      entries,
      scrollEl.scrollTop,
      OUTLINE_STICKY_ROW_H,
      OUTLINE_STICKY_MAX,
      TRACE_PIN_OPTS,
    )
  }
  return computePinnedScopeIds(scrollEl, undefined, TRACE_PIN_OPTS)
}

export type TraceScopeKind =
  | "context"
  | "prompt"
  | "tools"
  | "call"
  | "sent"
  | "received"
  | "phase"
  | "work"
  | "message"
  | "tool"

/**
 * Indent depth for in-flow headers and pin clones.
 * Messages nest under Sent (one deeper than Sent/Received).
 */
export function traceScopeDepth(
  kind: Exclude<TraceScopeKind, "tool">,
  nestedUnderPhase = false,
): number {
  switch (kind) {
    case "context":
    case "phase":
      return 0
    case "prompt":
    case "tools":
      return 1
    case "call":
    case "work":
      return nestedUnderPhase ? 1 : 0
    case "sent":
    case "received":
      return nestedUnderPhase ? 2 : 1
    case "message":
      return nestedUnderPhase ? 3 : 2
  }
}

export type TraceScopeEntry = {
  id: string
  kind: TraceScopeKind
  callIndex: number | null
  depth: number
  top: number
  el: HTMLElement
}

export function listTraceScopes(scrollEl: HTMLElement): TraceScopeEntry[] {
  const nodes = [...scrollEl.querySelectorAll<HTMLElement>("[data-trace-scope]")]
  const out: TraceScopeEntry[] = []
  for (const el of nodes) {
    const kind = (el.dataset.traceKind ?? "call") as TraceScopeKind
    if (
      kind !== "context" &&
      kind !== "prompt" &&
      kind !== "tools" &&
      kind !== "call" &&
      kind !== "sent" &&
      kind !== "received" &&
      kind !== "phase" &&
      kind !== "work" &&
      kind !== "message"
    ) {
      continue
    }
    out.push({
      id: el.dataset.traceScope!,
      kind,
      callIndex:
        el.dataset.traceCall == null || el.dataset.traceCall === ""
          ? null
          : Number(el.dataset.traceCall),
      depth: Number(el.dataset.traceDepth ?? "0") || 0,
      top: (() => {
        const s = scrollEl.getBoundingClientRect()
        const e = el.getBoundingClientRect()
        return e.top - s.top + scrollEl.scrollTop
      })(),
      el,
    })
  }
  return out
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
  phaseId?: string
  workId?: string
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

  if (scopeId.startsWith("phase-")) return { phaseId: scopeId }
  if (scopeId.startsWith("work-")) return { workId: scopeId }

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
