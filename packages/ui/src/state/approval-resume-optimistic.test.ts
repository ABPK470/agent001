import { describe, expect, it } from "vitest"
import { RunStatus } from "../enums"
import type { Run } from "../types"
import { applyOptimisticApprovalResume } from "./approval-resume-optimistic"

function parentRun(id = "parent"): Run {
  return {
    id,
    goal: "sync uat",
    status: RunStatus.WaitingForApproval,
    answer: null,
    stepCount: 2,
    error: null,
    parentRunId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    totalTokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    llmCalls: 0,
    trace: [{ kind: "approval-wait", toolName: "sync_execute", reason: "policy" }],
    threadId: "thread-1",
  }
}

describe("applyOptimisticApprovalResume", () => {
  it("links child to parent before marking parent cancelled", () => {
    const patches: Array<Partial<Run> & { id: string }> = []
    let activeId = "parent"

    applyOptimisticApprovalResume(
      "parent",
      "child",
      [parentRun()],
      (patch) => patches.push(patch),
      (id) => { activeId = id },
    )

    expect(activeId).toBe("child")
    expect(patches[0]).toMatchObject({
      id: "child",
      parentRunId: "parent",
      status: RunStatus.Running,
      goal: "sync uat",
      threadId: "thread-1",
    })
    expect(patches[1]).toMatchObject({
      id: "parent",
      status: RunStatus.Cancelled,
    })
  })
})
