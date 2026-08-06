import { describe, expect, it } from "vitest"
import {
  buildScopeDrawerItems,
  initialScopeDrawerIndex,
  moveScopeDrawerIndex,
} from "./trace-scope-drawer-nav"

describe("trace-scope-drawer-nav", () => {
  it("builds flat thread/run list from expanded set", () => {
    const runs = new Map<string, { id: string }[]>([
      ["t1", [{ id: "r1" }, { id: "r2" }]],
      ["t2", [{ id: "r3" }]],
    ])
    const items = buildScopeDrawerItems(
      [{ id: "t1" }, { id: "t2" }],
      runs,
      new Set(["t1"]),
    )
    expect(items).toEqual([
      { kind: "thread", threadId: "t1", expanded: true },
      { kind: "run", threadId: "t1", runId: "r1" },
      { kind: "run", threadId: "t1", runId: "r2" },
      { kind: "thread", threadId: "t2", expanded: false },
    ])
  })

  it("initial index prefers active run then thread", () => {
    const items = buildScopeDrawerItems(
      [{ id: "t1" }],
      new Map([["t1", [{ id: "r1" }, { id: "r2" }]]]),
      new Set(["t1"]),
    )
    expect(initialScopeDrawerIndex(items, "r2", "t1")).toBe(2)
    expect(initialScopeDrawerIndex(items, null, "t1")).toBe(0)
    expect(initialScopeDrawerIndex([], null, null)).toBe(-1)
  })

  it("moves index with clamp", () => {
    expect(moveScopeDrawerIndex(3, 0, 1)).toBe(1)
    expect(moveScopeDrawerIndex(3, 2, 1)).toBe(2)
    expect(moveScopeDrawerIndex(3, 0, -1)).toBe(0)
    expect(moveScopeDrawerIndex(0, -1, 1)).toBe(-1)
  })
})
