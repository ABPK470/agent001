import { describe, expect, it, vi } from "vitest"
import { RunStatus } from "../enums"
import type { Run } from "../types"
import { applyOptimisticApprovalDeny } from "./approval-deny-optimistic"

function run(partial: Partial<Run> & Pick<Run, "id">): Run {
  return {
    goal: "g",
    status: RunStatus.WaitingForApproval,
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
    trace: [{ kind: "approval-wait", toolName: "fetch_url", reason: "network" }],
    ...partial,
  }
}

describe("applyOptimisticApprovalDeny", () => {
  it("marks cancelled with deny reason and rewrites wait notes", () => {
    const upsert = vi.fn()
    applyOptimisticApprovalDeny(
      "run-1",
      "fetch_url",
      null,
      [run({ id: "run-1" })],
      upsert,
    )
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "run-1",
        status: RunStatus.Cancelled,
        error: "Tool approval denied for fetch_url.",
        trace: [{ kind: "approval-denied", toolName: "fetch_url" }],
      }),
    )
  })
})
