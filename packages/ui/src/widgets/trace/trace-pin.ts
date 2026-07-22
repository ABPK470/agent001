/**
 * Trace pin helpers — thin façade over lib/events/pin + Trace expand paths.
 */

import { computePinnedScopeIds } from "../../lib/events/pin"

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

/** Trace reserved-band pin math — focus line is the scrollport top. */
export const TRACE_PIN_OPTS = { stackInScroll: false } as const

export function computeTracePinnedScopeIds(scrollEl: HTMLElement): string[] {
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
