import { describe, expect, it } from "vitest"
import type { TraceEntry } from "@mia/shared-types"
import { RunStatus } from "../enums"
import {
  formatApprovalDeniedCancelDetail,
  formatApprovalDeniedLabel,
  formatApprovalWaitLabel,
  isApprovalDeniedCancelReason,
  isApprovalDeniedTraceText,
  isApprovalWaitTraceText,
  keepLastApprovalWaitTraceEntry,
  parseApprovalWaitMessage,
  projectTraceForChatDisplay,
  rewriteApprovalWaitEntriesToDenied,
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

  it("formats paused / denied labels", () => {
    expect(formatApprovalWaitLabel("fetch_url", "network")).toBe(
      "Paused for approval — fetch_url: network",
    )
    expect(formatApprovalDeniedLabel("fetch_url", "operator denied")).toBe(
      "Approval denied — fetch_url: operator denied",
    )
    expect(formatApprovalDeniedCancelDetail("fetch_url", "approval denied")).toBe(
      "Tool approval denied for fetch_url.",
    )
  })

  it("detects wait and deny dialects", () => {
    expect(isApprovalWaitTraceText("Waiting for approval — fetch_url: x")).toBe(true)
    expect(isApprovalDeniedTraceText("Approval denied — fetch_url")).toBe(true)
    expect(isApprovalDeniedCancelReason("approval denied")).toBe(true)
    expect(isApprovalDeniedCancelReason("Tool approval denied for fetch_url.")).toBe(true)
  })

  it("rewrites wait markers to a single denial cancel note", () => {
    const entries: TraceEntry[] = [
      { kind: "tool-call", tool: "fetch_url", summary: "x" },
      { kind: "error", text: "Waiting for approval — fetch_url: p1" },
      { kind: "error", text: "Waiting for approval — fetch_url: p2" },
    ]
    expect(rewriteApprovalWaitEntriesToDenied(entries, "fetch_url", null)).toEqual([
      { kind: "tool-call", tool: "fetch_url", summary: "x" },
      { kind: "error", text: "Approval denied — fetch_url" },
    ])
  })

  it("strips pause markers from settled history", () => {
    const entries: TraceEntry[] = [
      { kind: "tool-call", tool: "fetch_url", summary: "x" },
      { kind: "error", text: "Waiting for approval — fetch_url: p1" },
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

  it("projects chat trace: none when completed/cancelled, one when waiting", () => {
    const waiting: TraceEntry[] = [
      { kind: "error", text: "Waiting for approval — fetch_url: a" },
      { kind: "error", text: "Waiting for approval — fetch_url: b" },
    ]
    const denied: TraceEntry[] = [
      { kind: "error", text: "Approval denied — fetch_url" },
    ]
    expect(projectTraceForChatDisplay(waiting, RunStatus.WaitingForApproval)).toEqual([
      { kind: "error", text: "Waiting for approval — fetch_url: b" },
    ])
    expect(projectTraceForChatDisplay(denied, RunStatus.Cancelled)).toEqual([])
    expect(projectTraceForChatDisplay(waiting, RunStatus.Completed)).toEqual([])
  })
})
