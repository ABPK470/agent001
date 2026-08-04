import { describe, expect, it } from "vitest"
import { hasUsableTraceEntries, normalizeTraceWire } from "./trace-wire"

describe("normalizeTraceWire", () => {
  it("unwraps envelopes and keeps createdAt ms", () => {
    const normalized = normalizeTraceWire([
      {
        seq: 0,
        createdAt: "2026-01-01T00:00:00.000Z",
        entry: { kind: "goal", text: "hi" },
      },
      {
        seq: 1,
        createdAt: "2026-01-01T00:00:01.000Z",
        entry: {
          kind: "llm-request",
          iteration: 0,
          messageCount: 0,
          toolCount: 0,
          messages: [],
          stepName: "api_layer",
        },
      },
    ])
    expect(normalized.entries.map((e) => e.kind)).toEqual(["goal", "llm-request"])
    expect(normalized.createdAtMs[0]).toBe(Date.parse("2026-01-01T00:00:00.000Z"))
    expect(normalized.createdAtMs[1]).toBe(Date.parse("2026-01-01T00:00:01.000Z"))
  })

  it("accepts legacy bare TraceEntry arrays", () => {
    const normalized = normalizeTraceWire([{ kind: "goal", text: "hi" }])
    expect(normalized.entries).toEqual([{ kind: "goal", text: "hi" }])
    expect(normalized.createdAtMs).toEqual([null])
  })

  it("hasUsableTraceEntries rejects poisoned envelope blobs", () => {
    expect(hasUsableTraceEntries([])).toBe(false)
    expect(
      hasUsableTraceEntries([
        { seq: 0, createdAt: "2026-01-01T00:00:00.000Z", entry: { kind: "goal", text: "hi" } },
      ]),
    ).toBe(false)
    expect(hasUsableTraceEntries([{ kind: "goal", text: "hi" }])).toBe(true)
    const unwrapped = normalizeTraceWire([
      { seq: 0, createdAt: "2026-01-01T00:00:00.000Z", entry: { kind: "tool-call", tool: "query_mssql" } },
    ])
    expect(hasUsableTraceEntries(unwrapped.entries)).toBe(true)
  })
})
