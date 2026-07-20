import { describe, expect, it } from "vitest"
import { formatHttpTraceSummary, readHttpTraceFields } from "./sync-http-trace"

describe("sync-http-trace", () => {
  it("reads HTTP telemetry fields", () => {
    const fields = readHttpTraceFields({
      method: "POST",
      url: "https://example.com/etl/api/pipelines/register",
      status: 200,
      durationMs: 42,
      requestBody: { id: 1 },
      responseBody: { ok: true },
    })
    expect(fields?.method).toBe("POST")
    expect(formatHttpTraceSummary(fields!)).toBe("POST /etl/api/pipelines/register · 200")
  })
})
