import { describe, expect, it } from "vitest"
import { lookupEventDescriptor } from "./event-catalog.js"

describe("event-catalog step summaries", () => {
  it("includes tool action and args on step.started", () => {
    const d = lookupEventDescriptor("step.started")
    const summary = d.summary({
      action: "query_mssql",
      name: "query_mssql",
      input: { sql: "SELECT 1 AS n" },
      stepId: "step-22",
    })
    expect(summary).toContain("query_mssql")
    expect(summary.toLowerCase()).toMatch(/select|sql/)
  })

  it("includes output preview on step.completed", () => {
    const d = lookupEventDescriptor("step.completed")
    const summary = d.summary({
      action: "search_catalog",
      output: { result: "Found 3 entities matching customers" },
      durationMs: 1200,
    })
    expect(summary).toContain("search_catalog")
    expect(summary).toContain("Found 3 entities")
    expect(summary).toContain("1.2s")
  })

  it("includes error on step.failed", () => {
    const d = lookupEventDescriptor("step.failed")
    const summary = d.summary({
      action: "query_mssql",
      error: 'Tool "query_mssql" timed out after 120000ms',
    })
    expect(summary).toContain("query_mssql")
    expect(summary).toContain("timed out")
  })

  it("names the tool on tool_call.completed", () => {
    const d = lookupEventDescriptor("tool_call.completed")
    expect(d.summary({ toolName: "explore_mssql_schema" })).toBe(
      "explore_mssql_schema · completed",
    )
  })
})
