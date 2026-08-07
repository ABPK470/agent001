import { describe, expect, it } from "vitest"
import {
  canJoinZenSession,
  isZenViewId,
  resolveZenKeepCap,
  resolveZenToggleInSession,
  ZEN_SESSION_MAX,
} from "./zen-session"

describe("zen-session", () => {
  it("recognizes zen view ids", () => {
    expect(isZenViewId("zen:abc")).toBe(true)
    expect(isZenViewId("space:observe")).toBe(false)
  })

  it("allowlists focus-capable types only", () => {
    expect(canJoinZenSession("live-logs")).toBe(true)
    expect(canJoinZenSession("operation-log")).toBe(true)
    expect(canJoinZenSession("term-chat")).toBe(false)
  })

  it("Z shrinks a 2-tile set; exits a 1-tile set", () => {
    expect(resolveZenToggleInSession(["a"], "a")).toEqual({ type: "exit" })
    expect(resolveZenToggleInSession(["a", "b"], "a")).toEqual({
      type: "shrink",
      nextSet: ["b"],
    })
  })

  it("Keep under cap appends; at cap swaps focused", () => {
    const types = new Map<string, "live-logs" | "operation-log" | "debug-inspector">([
      ["a", "debug-inspector"],
      ["b", "operation-log"],
    ])
    expect(ZEN_SESSION_MAX).toBe(2)
    const under = resolveZenKeepCap(["a"], types, "a", "live-logs", "c")
    expect(under).toEqual({ nextSet: ["a", "c"], replaceId: null })
    const full = resolveZenKeepCap(["a", "b"], types, "b", "live-logs", "c")
    expect(full).toEqual({ nextSet: ["a", "c"], replaceId: "b" })
  })
})
