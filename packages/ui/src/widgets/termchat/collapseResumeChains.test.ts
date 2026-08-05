import { describe, expect, it } from "vitest"
import type { Run, TraceEntry } from "@mia/shared-types"
import {
  collapseResumeRunChains,
  dropApprovalWaitTraceEntries,
  isSupersededByResume,
} from "./collapseResumeChains"

function run(partial: Partial<Run> & Pick<Run, "id" | "goal">): Run {
  return {
    status: "completed",
    answer: null,
    stepCount: 0,
    error: null,
    parentRunId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:01:00.000Z",
    totalTokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    llmCalls: 0,
    trace: [],
    ...partial,
  }
}

describe("collapseResumeRunChains", () => {
  it("merges approval resume children under one goal and drops pause markers", () => {
    const parent = run({
      id: "p1",
      goal: "yes",
      status: "cancelled",
      createdAt: "2026-01-01T00:00:00.000Z",
      trace: [
        { kind: "tool-call", tool: "sync_execute", summary: "exec" },
        {
          kind: "error",
          text: "Waiting for approval — sync_execute: needs confirm",
        },
      ],
    })
    const child = run({
      id: "c1",
      goal: "yes",
      parentRunId: "p1",
      status: "completed",
      createdAt: "2026-01-01T00:00:30.000Z",
      answer: "Done.",
      trace: [{ kind: "answer", text: "Done." }],
    })

    const out = collapseResumeRunChains([parent, child])
    expect(out).toHaveLength(1)
    expect(out[0]!.id).toBe("c1")
    expect(out[0]!.goal).toBe("yes")
    expect(out[0]!.status).toBe("completed")
    expect(out[0]!.answer).toBe("Done.")
    expect(out[0]!.parentRunId).toBeNull()
    expect(isSupersededByResume(parent, [parent, child])).toBe(true)

    const texts = (out[0]!.trace ?? []).map((e) => ("text" in e ? e.text : e.kind))
    expect(texts.some((t) => String(t).includes("Waiting for approval"))).toBe(false)
    expect(texts.some((t) => String(t).includes("Approved"))).toBe(false)
    expect(texts).toContain("Done.")
  })

  it("collapses a chain of many approvals without approval spam in the trace", () => {
    const a = run({
      id: "a",
      goal: "sync uat to dev",
      status: "cancelled",
      createdAt: "2026-01-01T00:00:00.000Z",
      trace: [{ kind: "error", text: "Waiting for approval — sync_execute: p1" }],
    })
    const b = run({
      id: "b",
      goal: "sync uat to dev",
      parentRunId: "a",
      status: "cancelled",
      createdAt: "2026-01-01T00:01:00.000Z",
      trace: [{ kind: "error", text: "Waiting for approval — fetch_url: p2" }],
    })
    const c = run({
      id: "c",
      goal: "sync uat to dev",
      parentRunId: "b",
      status: "completed",
      createdAt: "2026-01-01T00:02:00.000Z",
      answer: "ok",
      trace: [{ kind: "answer", text: "ok" }],
    })

    const out = collapseResumeRunChains([a, b, c])
    expect(out).toHaveLength(1)
    expect(out[0]!.id).toBe("c")
    expect(out[0]!.goal).toBe("sync uat to dev")
    const trace = out[0]!.trace ?? []
    expect(trace.some((e) => e.kind === "error")).toBe(false)
    expect(trace.some((e) => "text" in e && String(e.text).includes("Approved"))).toBe(false)
  })

  it("leaves unrelated runs alone", () => {
    const a = run({ id: "1", goal: "one", createdAt: "2026-01-01T00:00:00.000Z" })
    const b = run({ id: "2", goal: "two", createdAt: "2026-01-01T00:01:00.000Z" })
    const out = collapseResumeRunChains([a, b])
    expect(out.map((r) => r.id)).toEqual(["1", "2"])
  })
})

describe("dropApprovalWaitTraceEntries", () => {
  it("removes approval pause markers but keeps real errors", () => {
    const entries: TraceEntry[] = [
      { kind: "error", text: "Waiting for approval — sync_execute: policy" },
      { kind: "error", text: 'Approval required for tool "fetch_url": network' },
      { kind: "error", text: "Tool failed hard" },
    ]
    const stripped = dropApprovalWaitTraceEntries(entries)
    expect(stripped).toEqual([{ kind: "error", text: "Tool failed hard" }])
  })
})
