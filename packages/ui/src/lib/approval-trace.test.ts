import type { TraceEntry } from "@mia/shared-types"
import { describe, expect, it } from "vitest"
import { RunStatus } from "../enums"
import {
  appendApprovalDeniedTraceEntry,
  isApprovalDeniedEntry,
  isApprovalWaitEntry,
  projectTraceForChatDisplay,
  stripApprovalWaitTraceEntries,
} from "./approval-trace"

function wait(
  approvalId: string,
  stepId: string,
  toolName = "fetch_url",
): TraceEntry {
  return {
    kind: "approval-wait",
    approvalId,
    stepId,
    toolName,
    reason: "policy",
  }
}

describe("approval trace", () => {
  it("narrows by wire kind only", () => {
    expect(isApprovalWaitEntry(wait("approval-1", "step-1"))).toBe(true)
    expect(isApprovalWaitEntry({ kind: "error", text: "Waiting for approval" })).toBe(false)
    expect(
      isApprovalDeniedEntry({
        kind: "approval-denied",
        approvalId: "approval-1",
        stepId: "step-1",
        toolName: "fetch_url",
      }),
    ).toBe(true)
  })

  it("does not create a denial without its approval wait", () => {
    const entries: TraceEntry[] = [{ kind: "goal", text: "Fetch report" }]
    const result = appendApprovalDeniedTraceEntry(entries, {
      approvalId: "approval-1",
      stepId: "step-1",
      toolName: "fetch_url",
    })

    expect(result).toBe(entries)
  })

  it("appends the denial without rewriting the timeline", () => {
    const firstWait = wait("approval-1", "step-1")
    const secondWait = wait("approval-2", "step-2")
    const entries: TraceEntry[] = [
      { kind: "goal", text: "Fetch report" },
      firstWait,
      { kind: "thinking", text: "Still working" },
      secondWait,
    ]

    const result = appendApprovalDeniedTraceEntry(entries, {
      approvalId: "approval-2",
      stepId: "step-2",
      toolName: "fetch_url",
      reason: "  operator denied  ",
    })

    expect(result).toEqual([
      ...entries,
      {
        kind: "approval-denied",
        approvalId: "approval-2",
        stepId: "step-2",
        toolName: "fetch_url",
        reason: "operator denied",
      },
    ])
    expect(result[1]).toBe(firstWait)
    expect(result[3]).toBe(secondWait)
  })

  it("does not append the same denial twice", () => {
    const entries: TraceEntry[] = [
      wait("approval-1", "step-1"),
      {
        kind: "approval-denied",
        approvalId: "approval-1",
        stepId: "step-1",
        toolName: "fetch_url",
      },
    ]

    const result = appendApprovalDeniedTraceEntry(entries, {
      approvalId: "approval-1",
      stepId: "step-1",
      toolName: "fetch_url",
    })

    expect(result).toBe(entries)
  })

  it("shows only the latest unresolved wait while the run is parked", () => {
    const entries: TraceEntry[] = [
      wait("approval-1", "step-1"),
      {
        kind: "approval-denied",
        approvalId: "approval-1",
        stepId: "step-1",
        toolName: "fetch_url",
      },
      { kind: "thinking", text: "Resumed" },
      wait("approval-2", "step-2", "write_file"),
    ]

    expect(
      projectTraceForChatDisplay(entries, RunStatus.WaitingForApproval),
    ).toEqual([
      { kind: "thinking", text: "Resumed" },
      wait("approval-2", "step-2", "write_file"),
    ])
  })

  it("removes approval control events from settled chat history", () => {
    const entries: TraceEntry[] = [
      wait("approval-1", "step-1"),
      {
        kind: "approval-denied",
        approvalId: "approval-1",
        stepId: "step-1",
        toolName: "fetch_url",
      },
      { kind: "error", text: "Tool failed hard" },
    ]

    expect(projectTraceForChatDisplay(entries, RunStatus.Cancelled)).toEqual([
      { kind: "error", text: "Tool failed hard" },
    ])
    expect(stripApprovalWaitTraceEntries(entries)).toEqual([
      entries[1],
      entries[2],
    ])
  })
})
