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

  it("callout classes use theme-split status-callout tokens (not policy softs)", () => {
    for (const tone of ["ok", "err", "warn", "info"] as const) {
      expect(STATUS_CALLOUT[tone]).toMatch(/status-callout-/)
      expect(STATUS_CALLOUT[tone]).toMatch(/border/)
      expect(STATUS_CALLOUT[tone]).toMatch(/text-text-muted/)
      expect(STATUS_CALLOUT[tone]).toMatch(/font-normal/)
      expect(STATUS_CALLOUT[tone]).not.toMatch(/policy-allow-soft|policy-deny-soft|policy-approval-soft/)
      expect(STATUS_CALLOUT[tone]).not.toMatch(/diff-surface/)
      expect(STATUS_CALLOUT_BADGE[tone]).toMatch(/status-callout-/)
    }
    expect(operationStatusCallout("failed")).toContain("status-callout-err")
    expect(operationStatusCallout("cancelled")).toContain("status-callout-warn")
    expect(operationStatusCallout("running")).toContain("status-callout-info")
    expect(operationStatusBadge("success")).toContain("status-callout-ok")
  })
})
