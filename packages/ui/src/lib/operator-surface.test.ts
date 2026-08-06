import { describe, expect, it } from "vitest"
import {
  claimOperatorSurface,
  getActiveOperatorSurface,
  resetOperatorSurfaceForTests,
} from "./operator-surface"

describe("operator surface registry", () => {
  it("claims and releases the active surface", () => {
    resetOperatorSurfaceForTests()
    const a = { id: "trace", onKeyDown: () => false }
    const releaseA = claimOperatorSurface(a)
    expect(getActiveOperatorSurface()).toBe(a)

    const b = { id: "pipelines", onKeyDown: () => true }
    const releaseB = claimOperatorSurface(b)
    expect(getActiveOperatorSurface()).toBe(b)

    releaseA()
    expect(getActiveOperatorSurface()).toBe(b)
    releaseB()
    expect(getActiveOperatorSurface()).toBeNull()
  })
})
