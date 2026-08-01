/**
 * Nested wheel for chat — tool I/O and tool-chain lists scroll first;
 * at their edge the transcript takes over.
 *
 * Hit-test uses the element under the pointer. Trackpad inertia often keeps
 * event.target on the pane that started the gesture; trusting that alone is
 * what made scroll feel stuck after the cursor left a full-width tool box.
 */

import { canElementScrollVertically } from "./milestone"

export type NestedScrollMetrics = {
  scrollHeight: number
  clientHeight: number
  scrollTop: number
}

export type NestedWheelAction =
  | { kind: "passthrough" }
  | { kind: "scroll"; index: number }
  | { kind: "host" }

/** Overflowing scroll parents from hit target up to (not including) host — innermost first. */
export function collectNestedScrollables(
  target: EventTarget | null,
  host: HTMLElement,
): HTMLElement[] {
  const out: HTMLElement[] = []
  let node =
    target instanceof Element
      ? target instanceof HTMLElement
        ? target
        : target.parentElement
      : null
  while (node && node !== host) {
    const style = window.getComputedStyle(node)
    const overflowY = style.overflowY
    if (
      (overflowY === "auto" || overflowY === "scroll") &&
      node.scrollHeight > node.clientHeight + 1
    ) {
      out.push(node)
    }
    node = node.parentElement
  }
  return out
}

/**
 * Prefer the element under the pointer over a stale event.target.
 */
export function wheelHitTarget(
  host: HTMLElement,
  clientX: number,
  clientY: number,
  fallback: EventTarget | null,
): EventTarget | null {
  if (typeof document === "undefined") return fallback
  const under = document.elementFromPoint(clientX, clientY)
  if (under instanceof Node && host.contains(under)) return under
  return fallback
}

/** Normalize wheel deltas to CSS pixels (LINE/PAGE modes are common on Windows). */
export function wheelDeltaPixels(
  deltaY: number,
  deltaMode: number,
  pageHeight: number,
): number {
  if (deltaMode === 1) return deltaY * 16
  if (deltaMode === 2) return deltaY * pageHeight
  return deltaY
}

/**
 * Pure decision from the pointer hit-test chain.
 * - scroll index 0 = innermost (I/O)
 * - scroll index >0 = outer nested (tool-chain list)
 * - host = nested at edge → transcript
 * - passthrough = pointer not over any nested overflow pane
 */
export function resolveNestedWheelAction(
  chain: readonly NestedScrollMetrics[],
  deltaY: number,
): NestedWheelAction {
  if (chain.length === 0) return { kind: "passthrough" }

  for (let i = 0; i < chain.length; i++) {
    if (!canElementScrollVertically(chain[i]!, deltaY)) continue
    return { kind: "scroll", index: i }
  }
  return { kind: "host" }
}

/**
 * Apply a wheel delta. Returns true when the caller must preventDefault.
 *
 * Always scrolls nested panes manually (never relies on browser default under
 * a capture listener). If the pointer has left nested panes but event.target
 * is still stuck on one, steals the gesture for the transcript host.
 */
export function handleNestedWheelDelta(
  event: Pick<WheelEvent, "target" | "clientX" | "clientY" | "deltaY" | "deltaMode">,
  host: HTMLElement,
): boolean {
  const deltaY = wheelDeltaPixels(event.deltaY, event.deltaMode, host.clientHeight)
  if (deltaY === 0) return false

  const hit = wheelHitTarget(host, event.clientX, event.clientY, event.target)
  const chain = collectNestedScrollables(hit, host)
  const staleChain = collectNestedScrollables(event.target, host)
  const action = resolveNestedWheelAction(chain, deltaY)

  if (action.kind === "passthrough") {
    // Pointer is outside nested overflow panes. If inertia still targets one,
    // move the transcript — otherwise the browser keeps "scrolling" a pane
    // that cannot move (stuck wheel).
    if (staleChain.length === 0) return false
    host.scrollTop += deltaY
    return true
  }

  if (action.kind === "scroll") {
    chain[action.index]!.scrollTop += deltaY
    return true
  }

  // Nested panes under the pointer are at their edge — transcript continues.
  host.scrollTop += deltaY
  return true
}
