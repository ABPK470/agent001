import { describe, expect, it } from "vitest"
import {
  STATUS_CALLOUT,
  STATUS_CALLOUT_BADGE,
  STATUS_ROW_STROKE,
  operationStatusBadge,
  operationStatusCallout,
  operationStatusRowStroke,
  statusCalloutTone,
} from "./status-callout"

describe("status-callout", () => {
  it("maps operation statuses onto policies dialect tones", () => {
    expect(statusCalloutTone("success")).toBe("ok")
    expect(statusCalloutTone("failed")).toBe("err")
    expect(statusCalloutTone("cancelled")).toBe("warn")
    expect(statusCalloutTone("canceled")).toBe("warn")
    expect(statusCalloutTone("warning")).toBe("warn")
    expect(statusCalloutTone("running")).toBe("info")
    expect(statusCalloutTone("waiting")).toBe("info")
    expect(statusCalloutTone("skipped")).toBe("skip")
  })

  it("callout classes use left stroke (no soft fill)", () => {
    for (const tone of ["ok", "err", "warn", "info"] as const) {
      expect(STATUS_CALLOUT[tone]).toMatch(/border-l-/)
      expect(STATUS_CALLOUT[tone]).toContain("bg-transparent")
      expect(STATUS_CALLOUT[tone]).toMatch(/text-text-muted/)
      expect(STATUS_CALLOUT[tone]).toMatch(/font-normal/)
      expect(STATUS_CALLOUT[tone]).not.toMatch(/status-callout-.*-soft|policy-allow-soft|policy-deny-soft/)
      expect(STATUS_CALLOUT[tone]).not.toMatch(/diff-surface/)
      expect(STATUS_CALLOUT_BADGE[tone]).toMatch(/border-l-/)
      expect(STATUS_CALLOUT_BADGE[tone]).toContain("bg-transparent")
      expect(STATUS_ROW_STROKE[tone]).toMatch(/mia-row-stroke/)
    }
    expect(operationStatusCallout("failed")).toContain("border-l-error")
    expect(operationStatusCallout("cancelled")).toContain("border-l-warning")
    expect(operationStatusCallout("running")).toContain("border-l-info")
    expect(operationStatusBadge("success")).toContain("border-l-success")
    expect(operationStatusRowStroke("failed")).toContain("mia-row-stroke--err")
  })
})
