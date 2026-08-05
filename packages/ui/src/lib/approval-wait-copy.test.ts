import { describe, expect, it } from "vitest"
import type { TraceEntry } from "@mia/shared-types"
import { RunStatus } from "../enums"
import {
  formatApprovalWaitLabel,
  isApprovalWaitTraceText,
  keepLastApprovalWaitTraceEntry,
  parseApprovalWaitMessage,
  projectTraceForChatDisplay,
  stripApprovalWaitTraceEntries,
} from "./approval-wait-copy"

describe("approval-wait-copy", () => {
  it("parses waiting-for-approval trace lines", () => {
    expect(parseApprovalWaitMessage("Waiting for approval — sync_execute: prod write")).toEqual({
      tool: "sync_execute",
      reason: "prod write",
    })
  })

  it("parses legacy server approval-required trace lines", () => {
    expect(parseApprovalWaitMessage('Approval required for tool "fetch_url": network')).toEqual({
      tool: "fetch_url",
      reason: "network",
    })
  })

  it("formats paused label for chat", () => {
    expect(formatApprovalWaitLabel("fetch_url", "network")).toBe(
      "Paused for approval — fetch_url: network",
    )
  })

  it("detects approval wait trace text in both dialects", () => {
    expect(isApprovalWaitTraceText("Waiting for approval — fetch_url: x")).toBe(true)
    expect(isApprovalWaitTraceText('Approval required for tool "fetch_url": x')).toBe(true)
    expect(isApprovalWaitTraceText("Tool failed hard")).toBe(false)
  })

  it("strips all pause markers from settled history", () => {
    const entries: TraceEntry[] = [
      { kind: "tool-call", tool: "fetch_url", summary: "x" },
      { kind: "error", text: "Waiting for approval — fetch_url: p1" },
      { kind: "error", text: "Waiting for approval — fetch_url: p2" },
    ]
    expect(stripApprovalWaitTraceEntries(entries)).toEqual([
      { kind: "tool-call", tool: "fetch_url", summary: "x" },
    ])
  })

  it("keeps only the latest pause marker while waiting", () => {
    const entries: TraceEntry[] = [
      { kind: "error", text: "Waiting for approval — fetch_url: old" },
      { kind: "tool-call", tool: "fetch_url", summary: "x" },
      { kind: "error", text: "Waiting for approval — fetch_url: latest" },
    ]
    expect(keepLastApprovalWaitTraceEntry(entries)).toEqual([
      { kind: "tool-call", tool: "fetch_url", summary: "x" },
      { kind: "error", text: "Waiting for approval — fetch_url: latest" },
    ])
  })

  it("projects chat trace: none when completed, one when waiting", () => {
    const entries: TraceEntry[] = [
      { kind: "error", text: "Waiting for approval — fetch_url: a" },
      { kind: "error", text: "Waiting for approval — fetch_url: b" },
    ]
    expect(projectTraceForChatDisplay(entries, RunStatus.Completed)).toEqual([])
    expect(projectTraceForChatDisplay(entries, RunStatus.WaitingForApproval)).toEqual([
      { kind: "error", text: "Waiting for approval — fetch_url: b" },
    ])
  })
})
