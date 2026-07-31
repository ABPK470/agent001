import { describe, expect, it } from "vitest"
import { threadDisplayRunCount } from "./thread-run-count.js"

describe("threadDisplayRunCount", () => {
  it("uses server count when runs are not loaded yet", () => {
    expect(threadDisplayRunCount(5, undefined)).toBe(5)
    expect(threadDisplayRunCount(0, undefined)).toBe(0)
    expect(threadDisplayRunCount(undefined, undefined)).toBe(0)
  })

  it("never treats a missing load as zero via empty-array placeholder", () => {
    // Regression: `runsByThread[id] ?? []` made collapsed rows show "0 runs".
    expect(threadDisplayRunCount(3, undefined)).toBe(3)
    expect(threadDisplayRunCount(3, [])).toBe(0) // confirmed empty after load
  })

  it("prefers loaded display length (collapsed chains)", () => {
    expect(threadDisplayRunCount(10, [{}, {}, {}])).toBe(3)
    expect(threadDisplayRunCount(1, [{}])).toBe(1)
  })
})
