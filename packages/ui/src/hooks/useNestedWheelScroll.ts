import { useLayoutEffect, type RefObject } from "react"
import { handleNestedWheelDelta } from "../widgets/termchat/nested-wheel"

/**
 * Nested wheel routing for a transcript / trace scroll host.
 * Re-bind when `bindKey` changes — the host element swaps across layout branches.
 */
export function useNestedWheelScroll(
  scrollHostRef: RefObject<HTMLElement | null>,
  bindKey: string | number | boolean = true,
): void {
  useLayoutEffect(() => {
    const host = scrollHostRef.current
    if (!host) return

    const handleWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) < Math.abs(event.deltaX) || event.deltaY === 0) return
      if (handleNestedWheelDelta(event, host)) {
        event.preventDefault()
      }
    }

    host.addEventListener("wheel", handleWheel, { capture: true, passive: false })
    return () => host.removeEventListener("wheel", handleWheel, { capture: true })
  }, [scrollHostRef, bindKey])
}
