import { describe, expect, it } from "vitest"
import { resolveEscLadder } from "./esc-ladder"

describe("resolveEscLadder", () => {
  it("dismisses summon before peeling widget layers", () => {
    expect(
      resolveEscLadder({
        summonOpen: true,
        scopeDrawerOpen: true,
        filterOpen: true,
        focusedPane: "detail",
        isZen: true,
        isSolo: true,
      }),
    ).toEqual({ type: "dismiss-summon" })
  })

  it("peels peek before summon when both are open", () => {
    expect(
      resolveEscLadder({
        summonOpen: true,
        modalWidgetOpen: true,
        filterOpen: false,
        focusedPane: "tree",
      }),
    ).toEqual({ type: "dismiss-peek" })
  })

  it("peels one layer at a time", () => {
    const base = {
      summonOpen: false,
      scopeDrawerOpen: false,
      filterOpen: false,
      focusedPane: "tree" as const,
      isZen: false,
      isSolo: false,
    }
    expect(resolveEscLadder({ ...base, scopeDrawerOpen: true })).toEqual({
      type: "dismiss-scope-drawer",
    })
    expect(resolveEscLadder({ ...base, filterOpen: true })).toEqual({ type: "dismiss-filter" })
    expect(resolveEscLadder({ ...base, focusedPane: "detail" })).toEqual({ type: "pane-to-tree" })
    expect(resolveEscLadder({ ...base, isZen: true })).toEqual({ type: "exit-zen" })
    expect(resolveEscLadder({ ...base, isSolo: true })).toEqual({ type: "restore-maximize" })
    expect(resolveEscLadder(base)).toEqual({ type: "none" })
  })
})
