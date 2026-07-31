import { describe, expect, it } from "vitest"
import {
  compensatePinBandInset,
  shouldParkAfterToggle,
} from "./chatScroll"

function mockScrollHost(stackH: string, scrollTop: number) {
  let css = stackH
  let top = scrollTop
  return {
    style: {
      getPropertyValue(name: string) {
        return name === "--trace-pin-stack-h" ? css : ""
      },
      setProperty(name: string, value: string) {
        if (name === "--trace-pin-stack-h") css = value
      },
    },
    get scrollTop() {
      return top
    },
    set scrollTop(v: number) {
      top = v
    },
  } as unknown as HTMLElement
}

describe("shouldParkAfterToggle", () => {
  it("header visible → fold only (no scroll park)", () => {
    // scrollTop at/below header doc Y — control still on screen
    expect(shouldParkAfterToggle(0, 0)).toBe(false)
    expect(shouldParkAfterToggle(40, 40)).toBe(false)
    expect(shouldParkAfterToggle(100, 120)).toBe(false)
    // +1 tolerance — do not park on a 1px boundary jitter
    expect(shouldParkAfterToggle(41, 40)).toBe(false)
  })

  it("scrolled into body → park after layout", () => {
    expect(shouldParkAfterToggle(42, 40)).toBe(true)
    expect(shouldParkAfterToggle(800, 40)).toBe(true)
  })
})

describe("compensatePinBandInset", () => {
  it("shifts scrollTop with pin-band height so content stays put on screen", () => {
    const el = mockScrollHost("34px", 100)

    compensatePinBandInset(el, 68)
    expect(el.style.getPropertyValue("--trace-pin-stack-h")).toBe("68px")
    expect(el.scrollTop).toBe(134)

    compensatePinBandInset(el, 34)
    expect(el.style.getPropertyValue("--trace-pin-stack-h")).toBe("34px")
    expect(el.scrollTop).toBe(100)
  })

  it("is a no-op when stack height is unchanged", () => {
    const el = mockScrollHost("34px", 50)
    compensatePinBandInset(el, 34)
    expect(el.scrollTop).toBe(50)
  })
})
