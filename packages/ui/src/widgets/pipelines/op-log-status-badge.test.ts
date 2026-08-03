import { describe, expect, it } from "vitest"
import { statusCalloutTone } from "../../lib/status-callout"
import { OpLogStatusPill } from "./OpLogStatusPill"

describe("OpLogStatusBadge", () => {
  it("maps success to ok tone", () => {
    expect(statusCalloutTone("success")).toBe("ok")
    expect(statusCalloutTone("failed")).toBe("err")
    expect(statusCalloutTone("running")).toBe("info")
  })

  it("exports a status pill component", () => {
    expect(typeof OpLogStatusPill).toBe("function")
  })
})
