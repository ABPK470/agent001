import { describe, expect, it } from "vitest"
import {
  STATUS_CALLOUT,
  STATUS_CALLOUT_BADGE,
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

  it("callout classes use soft wash + thin border + muted regular type", () => {
    for (const tone of ["ok", "err", "warn", "info"] as const) {
      expect(STATUS_CALLOUT[tone]).toMatch(/-soft/)
      expect(STATUS_CALLOUT[tone]).toMatch(/border/)
      expect(STATUS_CALLOUT[tone]).toMatch(/text-text-muted/)
      expect(STATUS_CALLOUT[tone]).toMatch(/font-normal/)
      expect(STATUS_CALLOUT[tone]).not.toMatch(/text-policy-|text-callout-info/)
      expect(STATUS_CALLOUT[tone]).not.toMatch(/diff-surface/)
      expect(STATUS_CALLOUT_BADGE[tone]).toMatch(/text-text-muted/)
      expect(STATUS_CALLOUT_BADGE[tone]).not.toMatch(/text-policy-|text-callout-info/)
    }
    expect(operationStatusCallout("failed")).toContain("policy-deny-soft")
    expect(operationStatusCallout("cancelled")).toContain("policy-approval-soft")
    expect(operationStatusCallout("running")).toContain("callout-info-soft")
    expect(operationStatusBadge("success")).toContain("policy-allow-soft")
  })
})
