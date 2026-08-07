import { describe, expect, it } from "vitest"
import { toggleMultiFilterChoice } from "./filter-multi-select"

const TYPES = ["run", "step", "sync", "bridge", "agent", "system", "api"] as const

describe("toggleMultiFilterChoice", () => {
  it("from empty (implicit all), one click excludes the target", () => {
    expect(toggleMultiFilterChoice(TYPES, [], "api")).toEqual([
      "run",
      "step",
      "sync",
      "bridge",
      "agent",
      "system",
    ])
  })

  it("toggles a chip once a partial selection exists", () => {
    expect(toggleMultiFilterChoice(TYPES, ["run", "step"], "api")).toEqual([
      "run",
      "step",
      "api",
    ])
    expect(toggleMultiFilterChoice(TYPES, ["run", "step"], "run")).toEqual(["step"])
  })

  it("collapses a full selection back to empty (no filter)", () => {
    const allButApi = TYPES.filter((t) => t !== "api")
    expect(toggleMultiFilterChoice(TYPES, allButApi, "api")).toEqual([])
  })

  it("keeps normal toggle when only one option exists (Errors only)", () => {
    expect(toggleMultiFilterChoice(["errors"], [], "errors")).toEqual(["errors"])
    expect(toggleMultiFilterChoice(["errors"], ["errors"], "errors")).toEqual([])
  })
})
