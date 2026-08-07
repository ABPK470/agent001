import { describe, expect, it } from "vitest"
import {
  invertMultiFilterChoice,
  selectMultiFilterChoice,
} from "./filter-multi-select"

const TYPES = ["run", "step", "sync", "bridge", "agent", "system", "api"] as const

describe("selectMultiFilterChoice (left-click)", () => {
  it("from empty (implicit all), selects only the target", () => {
    expect(selectMultiFilterChoice(TYPES, [], "api")).toEqual(["api"])
  })

  it("toggles a chip once a partial selection exists", () => {
    expect(selectMultiFilterChoice(TYPES, ["run", "step"], "api")).toEqual([
      "run",
      "step",
      "api",
    ])
    expect(selectMultiFilterChoice(TYPES, ["run", "step"], "run")).toEqual(["step"])
  })

  it("deselecting the only chip returns to empty (all)", () => {
    expect(selectMultiFilterChoice(TYPES, ["api"], "api")).toEqual([])
  })

  it("collapses a full selection back to empty (no filter)", () => {
    const allButApi = TYPES.filter((t) => t !== "api")
    expect(selectMultiFilterChoice(TYPES, allButApi, "api")).toEqual([])
  })

  it("keeps normal toggle when only one option exists (Errors only)", () => {
    expect(selectMultiFilterChoice(["errors"], [], "errors")).toEqual(["errors"])
    expect(selectMultiFilterChoice(["errors"], ["errors"], "errors")).toEqual([])
  })
})

describe("invertMultiFilterChoice (right-click)", () => {
  it("from empty (implicit all), selects all except the target", () => {
    expect(invertMultiFilterChoice(TYPES, [], "api")).toEqual([
      "run",
      "step",
      "sync",
      "bridge",
      "agent",
      "system",
    ])
  })

  it("is the inverse of left-click from empty", () => {
    const left = selectMultiFilterChoice(TYPES, [], "api")
    const right = invertMultiFilterChoice(TYPES, [], "api")
    expect(left).toEqual(["api"])
    expect(right).toEqual(TYPES.filter((t) => t !== "api"))
    expect(new Set([...left, ...right]).size).toBe(TYPES.length)
  })

  it("from only-X, right-click yields all except X", () => {
    expect(invertMultiFilterChoice(TYPES, ["api"], "api")).toEqual(
      TYPES.filter((t) => t !== "api"),
    )
  })

  it("repeating right-click on the same exclude set clears to all", () => {
    const except = TYPES.filter((t) => t !== "api")
    expect(invertMultiFilterChoice(TYPES, except, "api")).toEqual([])
  })
})
