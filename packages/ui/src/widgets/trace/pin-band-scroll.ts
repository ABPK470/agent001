/**
 * When the Trace pin band lives outside the scrollport, pin count changes
 * resize clientHeight. Compensating scrollTop by the band height delta keeps
 * the same document line under the band edge — except at peer handoff
 * (SENT → RECEIVED): the shorter stack pulls scrollTop back across the
 * threshold and the two peers fight every frame. Only apply compensation
 * when the pin set stays stable at the compensated scrollTop.
 */

import { samePinnedIds } from "../../lib/events/pin"

export function pinBandScrollDelta(
  prevPinCount: number,
  nextPinCount: number,
  rowH: number,
): number {
  return (nextPinCount - prevPinCount) * rowH
}

/**
 * Propose scrollTop after a pin-count change. If compensating would flip the
 * pin set (classic SENT/RECEIVED flicker), keep the document scrollTop and
 * accept a one-frame band jump instead.
 */
export function stabilizePinBandScrollTop(
  scrollTop: number,
  prevPinCount: number,
  nextIds: readonly string[],
  computeAt: (scrollTop: number) => string[],
  rowH: number,
): number {
  const delta = pinBandScrollDelta(prevPinCount, nextIds.length, rowH)
  if (delta === 0) return scrollTop
  const compensated = Math.max(0, scrollTop + delta)
  const atCompensated = computeAt(compensated)
  if (samePinnedIds(atCompensated, nextIds as string[])) return compensated
  return scrollTop
}
