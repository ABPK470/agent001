/**
 * Nested wheel for chat — tool I/O and tool-chain lists scroll first;
 * at their edge the transcript takes over. Hit-test uses the pointer
 * position (not a stale event.target) so leaving a pane unsticks scroll.
 */

import { canElementScrollVertically } from "./milestone"

export type NestedScrollMetrics = {
  scrollHeight: number
  clientHeight: number
  scrollTop: number
}

export type NestedWheelAction =
  | { kind: "passthrough" }
  | { kind: "browser" }
  | { kind: "scroll"; index: number }
  | { kind: "host" }

/** Overflowing scroll parents from hit target up to (not including) host — innermost first. */
export function collectNestedScrollables(
  target: EventTarget | null,
  host: HTMLElement,
): HTMLElement[] {
  const out: HTMLElement[] = []
  let node = target instanceof HTMLElement ? target : null
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
 * Prefer the element under the pointer. Wheel/trackpad inertia often keeps
 * event.target on the pane that started the gesture — that is what made
 * scroll feel "stuck" after the cursor left a full-width tool box.
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

/**
 * Pure decision — I/O → tool-chain → transcript host (escape at edge).
 */
export function resolveNestedWheelAction(
  chain: readonly NestedScrollMetrics[],
  deltaY: number,
): NestedWheelAction {
  if (chain.length === 0) return { kind: "passthrough" }

  for (let i = 0; i < chain.length; i++) {
    if (!canElementScrollVertically(chain[i]!, deltaY)) continue
    if (i === 0) return { kind: "browser" }
    return { kind: "scroll", index: i }
  }
  return { kind: "host" }
}

/**
 * Apply a wheel delta inside nested panes / host.
 * Returns true when the event was handled (caller should preventDefault).
 */
export function handleNestedWheelDelta(
  event: Pick<WheelEvent, "target" | "clientX" | "clientY" | "deltaY">,
  host: HTMLElement,
): boolean {
  const hit = wheelHitTarget(host, event.clientX, event.clientY, event.target)
  const chain = collectNestedScrollables(hit, host)
  const action = resolveNestedWheelAction(chain, event.deltaY)
  if (action.kind === "passthrough" || action.kind === "browser") return false
  if (action.kind === "scroll") {
    chain[action.index]!.scrollTop += event.deltaY
    return true
  }
  // Nested panes at edge — move the transcript (contain would otherwise eat the wheel).
  host.scrollTop += event.deltaY
  return true
}
