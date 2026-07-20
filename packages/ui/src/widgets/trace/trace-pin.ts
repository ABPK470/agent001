/**
 * VS Code–style sticky outline for Trace.
 *
 * Treats the scrollport as one document: once a Call header scrolls past
 * the top, it stays pinned. Later calls stack under earlier ones. Sent /
 * Received of the *current* call stack under that call.
 *
 * Critical: pin decisions use *layout* offsets (data-trace-flow-top), never
 * getBoundingClientRect while sticky — sticky moves the visual box and
 * would unpin on the next frame (flicker / disappear when scroll stops).
 */

export const TRACE_STICKY_ROW_H = 34

export type TraceScopeKind = "context" | "call" | "sent" | "received"

/**
 * Layout Y of `el` within `scrollEl`'s content (normal flow).
 * Uses offsetParent chain — stable under position:sticky.
 */
export function layoutOffsetInScroll(scrollEl: HTMLElement, el: HTMLElement): number {
  let top = 0
  let node: HTMLElement | null = el
  while (node && node !== scrollEl) {
    top += node.offsetTop
    const parent = node.offsetParent as HTMLElement | null
    if (!parent || parent === scrollEl) break
    if (!scrollEl.contains(parent)) {
      // offsetParent jumped outside the scrollport (e.g. to body).
      // Fall back to walking parentElement with getBoundingClientRect delta
      // only while sticky is cleared by the caller.
      const s = scrollEl.getBoundingClientRect()
      const e = el.getBoundingClientRect()
      return e.top - s.top + scrollEl.scrollTop
    }
    node = parent
  }
  return top
}

/** Clear sticky styles so layout offsets can be measured. */
export function clearTracePinStyles(scrollEl: HTMLElement): void {
  for (const el of scrollEl.querySelectorAll<HTMLElement>("[data-trace-scope]")) {
    el.style.position = ""
    el.style.top = ""
    el.style.zIndex = ""
    el.classList.remove("is-pinned")
  }
}

/**
 * Cache each scope's flow top on the element. Call only when sticky is
 * cleared (after expand/collapse / resize), never mid-scroll.
 */
export function refreshTraceFlowTops(scrollEl: HTMLElement): void {
  for (const el of scrollEl.querySelectorAll<HTMLElement>("[data-trace-scope]")) {
    el.dataset.traceFlowTop = String(layoutOffsetInScroll(scrollEl, el))
  }
}

function flowTopOf(el: HTMLElement): number {
  const raw = el.dataset.traceFlowTop
  if (raw != null && raw !== "") {
    const n = Number(raw)
    if (Number.isFinite(n)) return n
  }
  return 0
}

/** Scope ids that should be pinned for the current scrollTop. */
export function computePinnedScopeIds(scrollEl: HTMLElement): string[] {
  const scrollTop = scrollEl.scrollTop
  const nodes = [...scrollEl.querySelectorAll<HTMLElement>("[data-trace-scope]")]
  if (nodes.length === 0) return []

  const entries = nodes.map((el) => ({
    id: el.dataset.traceScope!,
    kind: el.dataset.traceKind as TraceScopeKind,
    callIndex:
      el.dataset.traceCall == null || el.dataset.traceCall === ""
        ? null
        : Number(el.dataset.traceCall),
    top: flowTopOf(el),
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
 * Does not remeasure — uses cached data-trace-flow-top only.
 */
export function applyTracePinStack(scrollEl: HTMLElement, pinnedIds: string[]): void {
  const nodes = [...scrollEl.querySelectorAll<HTMLElement>("[data-trace-scope]")]
  const pinnedIndex = new Map(pinnedIds.map((id, i) => [id, i]))

  for (const el of nodes) {
    const index = pinnedIndex.get(el.dataset.traceScope ?? "")
    if (index === undefined) {
      if (el.style.position === "sticky") {
        el.style.position = ""
        el.style.top = ""
        el.style.zIndex = ""
      }
      el.classList.remove("is-pinned")
      continue
    }
    el.style.position = "sticky"
    el.style.top = `${index * TRACE_STICKY_ROW_H}px`
    el.style.zIndex = String(60 - index)
    el.classList.add("is-pinned")
  }
}

/** Remeasure flow tops (sticky cleared) then pin for current scroll. */
export function remeasureAndPin(scrollEl: HTMLElement): void {
  clearTracePinStyles(scrollEl)
  refreshTraceFlowTops(scrollEl)
  applyTracePinStack(scrollEl, computePinnedScopeIds(scrollEl))
}

/** Pin using cached flow tops only — safe on every scroll frame. */
export function pinFromCache(scrollEl: HTMLElement): void {
  applyTracePinStack(scrollEl, computePinnedScopeIds(scrollEl))
}
