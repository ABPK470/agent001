import { describe, expect, it } from "vitest"

import { describeSqlEvent, formatTraceRowSummary, normalizeTraceStepName } from "./operation-log-trace"

describe("operation-log-trace", () => {
  it("normalizes SQL activity and flow-step labels", () => {
    expect(normalizeTraceStepName("SQL · FetchPkColumns(Core Activity)")).toBe(
      "FetchPkColumns(Core Activity)",
    )
    expect(normalizeTraceStepName("flowStep.auditCheck(auditCheck)")).toBe("auditCheck")
  })

  it("formats trace row summary without inline SQL text", () => {
    const trace = describeSqlEvent({
      type: "sync.preview.sql",
      timestamp: "2026-01-01T00:00:00.000Z",
      data: {
        label: "FetchPkColumns(Core Activity)",
        connection: "uat",
        sql: "SELECT 1",
        durationMs: 415,
      },
    })
    expect(formatTraceRowSummary(trace)).toBe("SQL FetchPkColumns(Core Activity) · uat · 415ms")
  })
})
