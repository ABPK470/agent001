import { describe, expect, it } from "vitest"
import {
  STATUS_CALLOUT,
  operationStatusBadge,
  operationStatusCallout,
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

  it("callout classes use soft wash + thin border + chroma (not sheet/diff)", () => {
    for (const tone of ["ok", "err", "warn", "info"] as const) {
      expect(STATUS_CALLOUT[tone]).toMatch(/-soft/)
      expect(STATUS_CALLOUT[tone]).toMatch(/border/)
      expect(STATUS_CALLOUT[tone]).not.toMatch(/diff-surface/)
      expect(STATUS_CALLOUT[tone]).not.toMatch(/error-soft|success-soft|warning-soft/)
    }
    expect(operationStatusCallout("failed")).toContain("policy-deny")
    expect(operationStatusCallout("cancelled")).toContain("policy-approval")
    expect(operationStatusCallout("running")).toContain("callout-info")
    expect(operationStatusBadge("success")).toContain("policy-allow")
  })
})
