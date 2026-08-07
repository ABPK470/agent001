import { describe, expect, it } from "vitest"
import { canOpenWidget, OPERATOR_WIDGETS, type WidgetType } from "./index.js"

const ADMIN_ONLY: readonly WidgetType[] = [
  "entity-registry",
  "bridge",
  "sync-admin",
  "active-users",
  "sync-proposals",
  "sync-approvals",
  "sync-evidence",
]

describe("canOpenWidget", () => {
  it("allows operator Personal surfaces including Trace", () => {
    for (const type of OPERATOR_WIDGETS) {
      expect(canOpenWidget(type, false)).toBe(true)
    }
    expect(canOpenWidget("debug-inspector", false)).toBe(true)
  })

  it("hides Platform control-plane from operators", () => {
    for (const type of ADMIN_ONLY) {
      expect(canOpenWidget(type, false)).toBe(false)
      expect(canOpenWidget(type, true)).toBe(true)
    }
  })

  it("hides Mymi for everyone", () => {
    expect(canOpenWidget("mymi-db", false)).toBe(false)
    expect(canOpenWidget("mymi-db", true)).toBe(false)
  })
})
