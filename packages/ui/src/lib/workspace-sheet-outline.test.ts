import { describe, expect, it } from "vitest"
import { rectInHost, workspaceSheetOutlinePath } from "./workspace-sheet-outline"

describe("workspaceSheetOutlinePath", () => {
  it("draws a plain rounded stage when there is no tab", () => {
    const d = workspaceSheetOutlinePath({ x: 10, y: 40, w: 200, h: 100 }, null, 16)
    expect(d.startsWith("M 26 40")).toBe(true)
    expect(d.includes("Z")).toBe(true)
    expect(d.includes("A 10")).toBe(false)
  })

  it("inserts scoops and a tab bump on the stage top", () => {
    const d = workspaceSheetOutlinePath(
      { x: 0, y: 40, w: 400, h: 200 },
      { x: 100, y: 4, w: 80, h: 36 },
      16,
      11,
      10,
    )
    expect(d.includes("L 90 40")).toBe(true)
    expect(d.includes("A 10 10 0 0 0 100 30")).toBe(true)
    expect(d.includes("A 11 11 0 0 1 111 4")).toBe(true)
    expect(d.includes("A 10 10 0 0 0 190 40")).toBe(true)
    expect(d.endsWith("Z")).toBe(true)
  })
})

describe("rectInHost", () => {
  it("translates a viewport box into host-local coords", () => {
    expect(rectInHost(
      { left: 100, top: 50 },
      { left: 140, top: 80, width: 20, height: 10 },
    )).toEqual({ x: 40, y: 30, w: 20, h: 10 })
  })
})
