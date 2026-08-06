import { describe, expect, it } from "vitest"
import type { Run, Thread } from "../../types"
import {
  combinedRunOptions,
  decodeCombinedValue,
  encodeCombinedValue,
  resolveCombinedListboxValue,
  resolveRunListboxValue,
  runOptionsForThread,
  threadOptions,
} from "./trace-run-context"

function thread(partial: Partial<Thread> & { id: string }): Thread {
  return {
    title: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  }
}

function run(partial: Partial<Run> & { id: string; threadId: string }): Run {
  return {
    goal: "goal",
    status: "completed",
    answer: null,
    stepCount: 0,
    error: null,
    parentRunId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    totalTokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    llmCalls: 0,
    ...partial,
  }
}

describe("trace-run-context", () => {
  it("orders threads pin-then-updated", () => {
    const opts = threadOptions([
      thread({ id: "a", title: "A", updatedAt: "2026-01-02T00:00:00.000Z" }),
      thread({ id: "b", title: "B", pinned: true, updatedAt: "2026-01-01T00:00:00.000Z" }),
    ])
    expect(opts.map((o) => o.value)).toEqual(["b", "a"])
  })

  it("resolveRunListboxValue matches / falls back / empty", () => {
    const runs = [{ id: "r1" }, { id: "r2" }]
    expect(resolveRunListboxValue(runs, "r2")).toBe("r2")
    expect(resolveRunListboxValue(runs, "foreign")).toBe("r1")
    expect(resolveRunListboxValue([], "r1")).toBe("")
    expect(resolveRunListboxValue([], null)).toBe("")
  })

  it("runOptionsForThread filters and collapses to thread", () => {
    const runs = [
      run({ id: "r1", threadId: "t1", goal: "one", createdAt: "2026-01-02T00:00:00.000Z" }),
      run({ id: "r2", threadId: "t2", goal: "other" }),
      run({ id: "r0", threadId: "t1", goal: "zero", createdAt: "2026-01-01T00:00:00.000Z" }),
    ]
    const opts = runOptionsForThread(runs, "t1")
    expect(opts.map((o) => o.value)).toEqual(["r1", "r0"])
  })

  it("encodes and decodes combined values", () => {
    const v = encodeCombinedValue("t1", "r1")
    expect(decodeCombinedValue(v)).toEqual({ threadId: "t1", runId: "r1" })
    expect(decodeCombinedValue(encodeCombinedValue("t1", ""))).toEqual({
      threadId: "t1",
      runId: "",
    })
    expect(decodeCombinedValue("bad")).toBeNull()
  })

  it("combined options and resolved value", () => {
    const threads = [
      thread({ id: "t1", title: "Alpha" }),
      thread({ id: "t2", title: "Empty" }),
    ]
    const runs = [
      run({ id: "r1", threadId: "t1", goal: "Inspect" }),
    ]
    const opts = combinedRunOptions(threads, runs)
    expect(opts.some((o) => o.label.includes("Alpha › Inspect"))).toBe(true)
    expect(opts.find((o) => o.value === encodeCombinedValue("t2", ""))?.label).toContain(
      "Empty › No runs",
    )
    expect(resolveCombinedListboxValue(threads, runs, "t1", "r1")).toBe(
      encodeCombinedValue("t1", "r1"),
    )
    expect(resolveCombinedListboxValue(threads, runs, "t1", "foreign")).toBe(
      encodeCombinedValue("t1", "r1"),
    )
    expect(resolveCombinedListboxValue(threads, runs, "t2", null)).toBe(
      encodeCombinedValue("t2", ""),
    )
  })
})
