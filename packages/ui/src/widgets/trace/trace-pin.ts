/**
 * VS Code–style sticky outline for Trace.
 *
 * Treats the scrollport as one document: once a Call header scrolls past
 * the top, it stays pinned. Later calls stack under earlier ones. Sent /
 * Received of the *current* call stack under that call.
 */

export const TRACE_STICKY_ROW_H = 34

export type TraceScopeKind = "context" | "call" | "sent" | "received"

function offsetInScroll(scrollEl: HTMLElement, el: HTMLElement): number {
  const s = scrollEl.getBoundingClientRect()
  const e = el.getBoundingClientRect()
  return e.top - s.top + scrollEl.scrollTop
}

/** Scope ids that should be pinned for the current scrollTop. */
export function computePinnedScopeIds(scrollEl: HTMLElement): string[] {
  const scrollTop = scrollEl.scrollTop
  const nodes = [...scrollEl.querySelectorAll<HTMLElement>("[data-trace-scope]")]
  if (nodes.length === 0) return []

  const entries = nodes.map((el) => ({
    el,
    id: el.dataset.traceScope!,
    kind: el.dataset.traceKind as TraceScopeKind,
    callIndex:
      el.dataset.traceCall == null || el.dataset.traceCall === ""
        ? null
        : Number(el.dataset.traceCall),
    top: offsetInScroll(scrollEl, el),
  }))

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

/**
 * Apply sticky top offsets to pinned scope rows; clear the rest.
 * Mutates DOM styles only — no overlay, no layout jump, flush to top.
 */
export function applyTracePinStack(scrollEl: HTMLElement, pinnedIds: string[]): void {
  const nodes = [...scrollEl.querySelectorAll<HTMLElement>("[data-trace-scope]")]
  const pinnedSet = new Set(pinnedIds)

  for (const el of nodes) {
    el.style.position = ""
    el.style.top = ""
    el.style.zIndex = ""
    el.classList.remove("is-pinned")
  }

  pinnedIds.forEach((id, index) => {
    const el = nodes.find((n) => n.dataset.traceScope === id)
    if (!el) return
    el.style.position = "sticky"
    el.style.top = `${index * TRACE_STICKY_ROW_H}px`
    el.style.zIndex = String(60 - index)
    el.classList.add("is-pinned")
  })

  // Mark covered only for pinned (for optional styling); ids unused here
  // but kept for callers that want the set.
  void pinnedSet
}
