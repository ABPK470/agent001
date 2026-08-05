/**
 * Store SSE handling for tool approval lifecycle.
 */

import { beforeEach, describe, expect, it } from "vitest"
import { RunStatus } from "../enums"
import { useStore } from "./store"

function resetApprovalState(): void {
  useStore.setState({
    pendingToolApproval: null,
    approvalModalOpen: false,
    approvalModalDismissed: false,
    notifications: [],
    unreadCount: 0,
    runs: [],
    trace: [],
    sseEventLog: [],
  })
}

describe("store approval events", () => {
  beforeEach(() => {
    resetApprovalState()
  })

  it("approval.required opens modal only when approvalId is present", () => {
    const { handleEvent } = useStore.getState()
    handleEvent({
      type: "approval.required",
      timestamp: new Date().toISOString(),
      data: {
        runId: "run-1",
        stepId: "step-1",
        toolName: "fetch_url",
        reason: "network",
      },
    })

    let state = useStore.getState()
    expect(state.approvalModalOpen).toBe(false)
    expect(state.pendingToolApproval?.approvalId).toBeNull()

    handleEvent({
      type: "approval.required",
      timestamp: new Date().toISOString(),
      data: {
        runId: "run-1",
        stepId: "step-1",
        toolName: "fetch_url",
        reason: "network",
        approvalId: "appr-1",
      },
    })

    state = useStore.getState()
    expect(state.approvalModalOpen).toBe(true)
    expect(state.pendingToolApproval).toMatchObject({
      approvalId: "appr-1",
      runId: "run-1",
      stepId: "step-1",
      toolName: "fetch_url",
    })
  })

  it("approval.required appends approval-wait (not error) to the run trace", async () => {
    useStore.getState().upsertRun({
      id: "run-wait",
      goal: "test goal",
      status: RunStatus.Running,
      answer: null,
      stepCount: 0,
      error: null,
      parentRunId: null,
      createdAt: new Date().toISOString(),
      completedAt: null,
      totalTokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      llmCalls: 0,
      trace: [],
    })
    useStore.getState().handleEvent({
      type: "approval.required",
      timestamp: new Date().toISOString(),
      data: {
        runId: "run-wait",
        stepId: "step-1",
        toolName: "fetch_url",
        reason: "network",
        approvalId: "appr-wait",
      },
    })
    await Promise.resolve()
    expect(useStore.getState().runs.find((r) => r.id === "run-wait")?.trace).toEqual([
      { kind: "approval-wait", toolName: "fetch_url", reason: "network" },
    ])
  })

  it("opens modal when approvalId arrives even if dismiss happened before id was known", () => {
    const { handleEvent } = useStore.getState()
    handleEvent({
      type: "approval.required",
      timestamp: new Date().toISOString(),
      data: {
        runId: "run-1",
        stepId: "step-1",
        toolName: "fetch_url",
        reason: "network",
      },
    })
    // Dismiss while still waiting for the authoritative id (e.g. hydrate poison).
    useStore.getState().setApprovalModalOpen(false)

    handleEvent({
      type: "approval.required",
      timestamp: new Date().toISOString(),
      data: {
        runId: "run-1",
        stepId: "step-1",
        toolName: "fetch_url",
        reason: "network",
        approvalId: "appr-final",
      },
    })

    const state = useStore.getState()
    expect(state.pendingToolApproval?.approvalId).toBe("appr-final")
    expect(state.approvalModalOpen).toBe(true)
    expect(state.approvalModalDismissed).toBe(false)
  })

  it("does not reopen after Decide later once the modal was actionable", () => {
    const { handleEvent } = useStore.getState()
    handleEvent({
      type: "approval.required",
      timestamp: new Date().toISOString(),
      data: {
        runId: "run-1",
        stepId: "step-1",
        toolName: "fetch_url",
        reason: "network",
        approvalId: "appr-1",
      },
    })
    expect(useStore.getState().approvalModalOpen).toBe(true)
    useStore.getState().setApprovalModalOpen(false)

    handleEvent({
      type: "approval.required",
      timestamp: new Date().toISOString(),
      data: {
        runId: "run-1",
        stepId: "step-1",
        toolName: "fetch_url",
        reason: "network",
        approvalId: "appr-1",
      },
    })

    expect(useStore.getState().approvalModalOpen).toBe(false)
  })

  it("hydratePendingToolApproval restores quietly without poisoning dismissed", () => {
    useStore.getState().hydratePendingToolApproval({
      approvalId: "appr-hydrated",
      runId: "run-1",
      stepId: "step-1",
      toolName: "fetch_url",
      reason: "network",
      notificationId: "note-1",
    })

    let state = useStore.getState()
    expect(state.approvalModalOpen).toBe(false)
    expect(state.approvalModalDismissed).toBe(false)
    expect(state.pendingToolApproval?.approvalId).toBe("appr-hydrated")

    // A different live approval must still be able to open the modal.
    useStore.getState().handleEvent({
      type: "approval.required",
      timestamp: new Date().toISOString(),
      data: {
        runId: "run-2",
        stepId: "step-9",
        toolName: "sync_execute",
        reason: "prod write",
        approvalId: "appr-live",
      },
    })

    state = useStore.getState()
    expect(state.approvalModalOpen).toBe(true)
    expect(state.pendingToolApproval?.approvalId).toBe("appr-live")
  })

  it("approval.resolved clears pending modal state and links resume child", () => {
    useStore.getState().upsertRun({
      id: "run-1",
      goal: "test goal",
      status: RunStatus.WaitingForApproval,
      answer: null,
      stepCount: 0,
      error: null,
      parentRunId: null,
      createdAt: new Date().toISOString(),
      completedAt: null,
      totalTokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      llmCalls: 0,
      trace: [{ kind: "approval-wait", toolName: "fetch_url", reason: "network" }],
    })
    useStore.getState().setPendingToolApproval({
      approvalId: "appr-1",
      runId: "run-1",
      stepId: "step-1",
      toolName: "fetch_url",
      reason: "network",
    })

    useStore.getState().handleEvent({
      type: "approval.resolved",
      timestamp: new Date().toISOString(),
      data: {
        runId: "run-1",
        stepId: "step-1",
        approvalId: "appr-1",
        decision: "approved",
        by: "alice@example.com",
        resumedRunId: "run-1-resumed",
      },
    })

    const state = useStore.getState()
    expect(state.pendingToolApproval).toBeNull()
    expect(state.approvalModalOpen).toBe(false)
    expect(state.runs.find((r) => r.id === "run-1-resumed")?.parentRunId).toBe("run-1")
    expect(state.runs.find((r) => r.id === "run-1")?.status).toBe(RunStatus.Cancelled)
    expect(state.activeRunId).toBe("run-1-resumed")
  })

  it("approval.resolved denied cancels with deny reason and rewrites wait notes", () => {
    useStore.getState().upsertRun({
      id: "run-deny",
      goal: "test goal",
      status: RunStatus.WaitingForApproval,
      answer: null,
      stepCount: 0,
      error: null,
      parentRunId: null,
      createdAt: new Date().toISOString(),
      completedAt: null,
      totalTokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      llmCalls: 0,
      trace: [{ kind: "approval-wait", toolName: "fetch_url", reason: "network" }],
    })
    useStore.getState().setPendingToolApproval({
      approvalId: "appr-deny",
      runId: "run-deny",
      stepId: "step-1",
      toolName: "fetch_url",
      reason: "network",
    })

    useStore.getState().handleEvent({
      type: "approval.resolved",
      timestamp: new Date().toISOString(),
      data: {
        runId: "run-deny",
        stepId: "step-1",
        approvalId: "appr-deny",
        decision: "denied",
        by: "alice@example.com",
        reason: "approval denied",
      },
    })

    const denied = useStore.getState().runs.find((r) => r.id === "run-deny")
    expect(denied?.status).toBe(RunStatus.Cancelled)
    expect(denied?.error).toBe("Tool approval denied for fetch_url.")
    expect(denied?.trace).toEqual([{ kind: "approval-denied", toolName: "fetch_url" }])
    expect(useStore.getState().pendingToolApproval).toBeNull()
  })

  it("notification approval.required enriches pending state with notificationId", () => {
    useStore.getState().handleEvent({
      type: "notification",
      timestamp: new Date().toISOString(),
      data: {
        id: "note-1",
        notificationType: "approval.required",
        title: "Approval required",
        message: 'Tool "fetch_url" needs approval: network',
        runId: "run-1",
        stepId: "step-1",
        actions: [
          {
            label: "Approve",
            action: "approve-run-step",
            data: {
              approvalId: "appr-1",
              runId: "run-1",
              stepId: "step-1",
              toolName: "fetch_url",
              reason: "network",
            },
          },
        ],
      },
    })

    expect(useStore.getState().pendingToolApproval).toMatchObject({
      approvalId: "appr-1",
      notificationId: "note-1",
      toolName: "fetch_url",
      reason: "network",
    })
  })
})
