import { describe, expect, it } from "vitest"
import {
  partitionSummonBag,
  resolveSummonLand,
  toggleSummonPick,
} from "./summon-pick"

describe("toggleSummonPick", () => {
  it("adds and removes a surface", () => {
    const once = toggleSummonPick(new Set(), "live-logs")
    expect([...once]).toEqual(["live-logs"])
    expect([...toggleSummonPick(once, "live-logs")]).toEqual([])
  })
})

describe("partitionSummonBag", () => {
  it("splits absent keeps from present removes", () => {
    expect(
      partitionSummonBag(
        ["live-logs", "operation-log", "bridge"],
        new Set(["operation-log", "bridge"]),
      ),
    ).toEqual({
      keep: ["live-logs"],
      remove: ["operation-log", "bridge"],
    })
  })
})

describe("resolveSummonLand", () => {
  it("bag applies keep for absent and remove for present", () => {
    expect(
      resolveSummonLand({
        bag: ["live-logs", "operation-log"],
        presentTypes: new Set(["operation-log"]),
        cursorType: "live-logs",
        modEnter: true,
      }),
    ).toEqual({
      type: "apply-widgets",
      keep: ["live-logs"],
      remove: ["operation-log"],
      focusType: "live-logs",
    })
  })

  it("bag of only Active surfaces removes them", () => {
    expect(
      resolveSummonLand({
        bag: ["live-logs", "operation-log"],
        presentTypes: new Set(["live-logs", "operation-log"]),
      }),
    ).toEqual({
      type: "apply-widgets",
      keep: [],
      remove: ["live-logs", "operation-log"],
      focusType: undefined,
    })
  })

  it("empty bag + cursor keeps or focuses a single surface", () => {
    expect(
      resolveSummonLand({
        bag: [],
        cursorType: "live-logs",
        cursorPresent: false,
      }),
    ).toEqual({
      type: "keep-widgets",
      widgets: ["live-logs"],
      focusType: "live-logs",
    })
    expect(
      resolveSummonLand({
        bag: [],
        cursorType: "live-logs",
        cursorPresent: true,
      }),
    ).toEqual({ type: "focus-tile", widgetType: "live-logs" })
  })

  it("empty bag + Mod+Enter peeks", () => {
    expect(
      resolveSummonLand({
        bag: [],
        cursorType: "live-logs",
        modEnter: true,
      }),
    ).toEqual({ type: "peek-widget", widgetType: "live-logs" })
  })

  it("empty bag without cursor is a no-op", () => {
    expect(resolveSummonLand({ bag: [] })).toBeNull()
  })
})
