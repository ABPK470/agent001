import { describe, expect, it } from "vitest"
import {
  STATUS_CALLOUT,
  STATUS_PILL,
  STATUS_ROW_STROKE,
  operationStatusCallout,
  operationStatusPill,
  operationStatusRowStroke,
  statusAbbrevMeta,
  statusCalloutTone,
} from "./status-callout"

describe("status-callout", () => {
  it("maps operation statuses onto policies dialect tones", () => {
    expect(statusCalloutTone("success")).toBe("ok")
    expect(statusCalloutTone("validated")).toBe("ok")
    expect(statusCalloutTone("failed")).toBe("err")
    expect(statusCalloutTone("crashed")).toBe("err")
    expect(statusCalloutTone("cancelled")).toBe("warn")
    expect(statusCalloutTone("canceled")).toBe("warn")
    expect(statusCalloutTone("warning")).toBe("warn")
    expect(statusCalloutTone("running")).toBe("info")
    expect(statusCalloutTone("waiting")).toBe("info")
    expect(statusCalloutTone("skipped")).toBe("skip")
  })

  it("callout classes use left stroke (dark dialect; light wash in CSS)", () => {
    for (const tone of ["ok", "err", "warn", "info"] as const) {
      expect(STATUS_CALLOUT[tone]).toMatch(/border-l-/)
      expect(STATUS_CALLOUT[tone]).toContain("bg-transparent")
      expect(STATUS_CALLOUT[tone]).toMatch(/text-text-muted/)
      expect(STATUS_CALLOUT[tone]).toMatch(/font-normal/)
      expect(STATUS_ROW_STROKE[tone]).toMatch(/mia-row-stroke/)
    }
    expect(operationStatusCallout("failed")).toContain("border-l-error")
    expect(operationStatusCallout("cancelled")).toContain("border-l-warning")
    expect(operationStatusCallout("running")).toContain("border-l-info")
    expect(operationStatusRowStroke("failed")).toContain("mia-row-stroke--err")
  })

  it("pill classes use chunky scan anchors (not hairline strokes)", () => {
    for (const tone of ["ok", "err", "warn", "info", "skip", "muted"] as const) {
      expect(STATUS_PILL[tone]).toBe(`mia-status-pill mia-status-pill--${tone}`)
      expect(STATUS_PILL[tone]).not.toMatch(/border-l-/)
      expect(STATUS_PILL[tone]).not.toMatch(/border-dashed|bg-transparent|text-text-muted/)
    }
    expect(operationStatusPill("success")).toContain("mia-status-pill--ok")
    expect(operationStatusPill("failed")).toContain("mia-status-pill--err")
    expect(operationStatusPill("running")).toContain("mia-status-pill--info")
    expect(operationStatusPill("skipped")).toContain("mia-status-pill--skip")
    expect(operationStatusPill("unknown")).toContain("mia-status-pill--muted")
  })

  it("abbreviates dense rail labels like Trace (OK · Fail · Run · CANC)", () => {
    expect(statusAbbrevMeta("completed").label).toBe("OK")
    expect(statusAbbrevMeta("failed").label).toBe("Fail")
    expect(statusAbbrevMeta("running").label).toBe("Run")
    expect(statusAbbrevMeta("cancelled")).toEqual({
      label: "CANC",
      icon: "–",
      title: "Cancelled",
    })
    expect(statusAbbrevMeta("pending").label).toBe("Run")
  })
})
