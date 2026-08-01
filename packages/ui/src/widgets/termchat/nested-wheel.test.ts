import { describe, expect, it } from "vitest"
import { resolveNestedWheelAction, wheelDeltaPixels } from "./nested-wheel"

describe("resolveNestedWheelAction", () => {
  it("passthrough when there is no nested overflow pane", () => {
    expect(resolveNestedWheelAction([], 10)).toEqual({ kind: "passthrough" })
  })

  it("scrolls the innermost pane when it still can", () => {
    expect(
      resolveNestedWheelAction(
        [
          { scrollHeight: 300, clientHeight: 100, scrollTop: 0 },
          { scrollHeight: 400, clientHeight: 200, scrollTop: 0 },
        ],
        10,
      ),
    ).toEqual({ kind: "scroll", index: 0 })
  })

  it("hands the wheel to the tool-chain list when I/O is at its edge", () => {
    expect(
      resolveNestedWheelAction(
        [
          { scrollHeight: 300, clientHeight: 100, scrollTop: 200 },
          { scrollHeight: 400, clientHeight: 200, scrollTop: 0 },
        ],
        10,
      ),
    ).toEqual({ kind: "scroll", index: 1 })
  })

  it("hands the wheel to the transcript when every nested pane is at its edge", () => {
    expect(
      resolveNestedWheelAction(
        [
          { scrollHeight: 300, clientHeight: 100, scrollTop: 200 },
          { scrollHeight: 400, clientHeight: 200, scrollTop: 200 },
        ],
        10,
      ),
    ).toEqual({ kind: "host" })
  })
})

describe("wheelDeltaPixels", () => {
  it("keeps pixel mode as-is and expands line/page modes", () => {
    expect(wheelDeltaPixels(40, 0, 800)).toBe(40)
    expect(wheelDeltaPixels(3, 1, 800)).toBe(48)
    expect(wheelDeltaPixels(1, 2, 800)).toBe(800)
  })
})
