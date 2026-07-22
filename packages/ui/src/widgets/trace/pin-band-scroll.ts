/**
 * When the Trace pin band lives outside the scrollport, pin count changes
 * resize clientHeight and cancel wheel deltas. Compensate scrollTop by the
 * band height delta so content stays visually stable under the band edge.
 */

export function pinBandScrollDelta(
  prevPinCount: number,
  nextPinCount: number,
  rowH: number,
): number {
  return (nextPinCount - prevPinCount) * rowH
}
