import { describe, expect, it } from "vitest"
import { resolveOperatorSession } from "./resolve-operator-layer"

describe("resolveOperatorSession", () => {
  const base = {
    summonOpen: false,
    keymapSheetOpen: false,
    modalWidgetOpen: false,
    editable: false,
    isEscape: false,
    hasActiveSurface: true,
  }

  it("overlays own the session", () => {
    expect(resolveOperatorSession({ ...base, summonOpen: true })).toEqual({ type: "overlay" })
    expect(resolveOperatorSession({ ...base, keymapSheetOpen: true })).toEqual({
      type: "overlay",
    })
  })

  it("dispatches shell then surface when clear", () => {
    expect(resolveOperatorSession(base)).toEqual({
      type: "dispatch",
      allowShell: true,
      allowSurface: true,
    })
  })

  it("Esc peels surface ladder when no modal", () => {
    expect(resolveOperatorSession({ ...base, isEscape: true })).toEqual({
      type: "dispatch",
      allowShell: false,
      allowSurface: true,
    })
  })

  it("Esc closes modalWidget at shell before surface", () => {
    expect(
      resolveOperatorSession({ ...base, isEscape: true, modalWidgetOpen: true }),
    ).toEqual({
      type: "dispatch",
      allowShell: true,
      allowSurface: false,
    })
  })

  it("stays quiet while typing (non-Esc)", () => {
    expect(resolveOperatorSession({ ...base, editable: true })).toEqual({ type: "none" })
  })
})
