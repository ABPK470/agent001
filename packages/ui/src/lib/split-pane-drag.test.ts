import type { PointerEvent as ReactPointerEvent } from "react"
import { describe, expect, it } from "vitest"
import {
  beginSplitPaneDrag,
  clampSplitRatio,
  moveSplitPaneDrag,
} from "./split-pane-drag"

describe("split-pane-drag", () => {
  it("clamps ratio", () => {
    expect(clampSplitRatio(0.1, 0.2, 0.8)).toBe(0.2)
    expect(clampSplitRatio(0.9, 0.2, 0.8)).toBe(0.8)
  })

  it("moves ratio by pointer delta", () => {
    const drag = {
      pointerId: 1,
      startX: 100,
      startRatio: 0.4,
      containerWidth: 1000,
    }
    const next = moveSplitPaneDrag(
      drag,
      { clientX: 150, pointerId: 1 } as unknown as React.PointerEvent<HTMLElement>,
      0.28,
      0.62,
    )
    expect(next).toBeCloseTo(0.45, 2)
  })

  it("returns null when not primary button", () => {
    const el = {
      setPointerCapture: () => {},
      clientWidth: 1000,
    } as unknown as HTMLElement
    const event = {
      button: 1,
      currentTarget: el,
      preventDefault: () => {},
      pointerId: 1,
      clientX: 0,
    } as unknown as ReactPointerEvent<HTMLElement>
    expect(beginSplitPaneDrag(event, el, 0.4)).toBeNull()
  })
})
