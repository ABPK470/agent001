import { describe, expect, it } from "vitest"
import type { TraceEntry } from "@mia/shared-types"
import { RunStatus } from "../enums"
import {
  formatApprovalDeniedCancelDetail,
  formatApprovalDeniedLabel,
  formatApprovalWaitLabel,
  isApprovalDeniedEntry,
  isApprovalWaitEntry,
  keepLastApprovalWaitTraceEntry,
  projectTraceForChatDisplay,
  rewriteApprovalWaitEntriesToDenied,
  stripApprovalWaitTraceEntries,
} from "./approval-wait-copy"

describe("approval-wait-copy", () => {
  it("formats paused / denied labels from structured fields", () => {
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

  it("narrows by wire kind only", () => {
    expect(isApprovalWaitEntry({ kind: "approval-wait", toolName: "fetch_url", reason: "x" })).toBe(true)
    expect(isApprovalWaitEntry({ kind: "error", text: "Waiting for approval — fetch_url: x" })).toBe(false)
    expect(isApprovalDeniedEntry({ kind: "approval-denied", toolName: "fetch_url" })).toBe(true)
    expect(isApprovalDeniedEntry({ kind: "error", text: "Approval denied — fetch_url" })).toBe(false)
  })

  it("rewrites wait markers to a single structured denial note", () => {
    const entries: TraceEntry[] = [
      { kind: "tool-call", tool: "fetch_url", summary: "x" },
      { kind: "approval-wait", toolName: "fetch_url", reason: "p1" },
      { kind: "approval-wait", toolName: "fetch_url", reason: "p2" },
    ]
    expect(rewriteApprovalWaitEntriesToDenied(entries, "fetch_url", null)).toEqual([
      { kind: "tool-call", tool: "fetch_url", summary: "x" },
      { kind: "approval-denied", toolName: "fetch_url" },
    ])
  })

  it("strips pause markers from settled history", () => {
    const entries: TraceEntry[] = [
      { kind: "tool-call", tool: "fetch_url", summary: "x" },
      { kind: "approval-wait", toolName: "fetch_url", reason: "p1" },
    ]
    expect(stripApprovalWaitTraceEntries(entries)).toEqual([
      { kind: "tool-call", tool: "fetch_url", summary: "x" },
    ])
  })

  it("keeps only the latest pause marker while waiting", () => {
    const entries: TraceEntry[] = [
      { kind: "approval-wait", toolName: "fetch_url", reason: "old" },
      { kind: "tool-call", tool: "fetch_url", summary: "x" },
      { kind: "approval-wait", toolName: "fetch_url", reason: "latest" },
    ]
    expect(keepLastApprovalWaitTraceEntry(entries)).toEqual([
      { kind: "tool-call", tool: "fetch_url", summary: "x" },
      { kind: "approval-wait", toolName: "fetch_url", reason: "latest" },
    ])
  })

  it("projects chat trace: none when completed/cancelled, one when waiting", () => {
    const waiting: TraceEntry[] = [
      { kind: "approval-wait", toolName: "fetch_url", reason: "a" },
      { kind: "approval-wait", toolName: "fetch_url", reason: "b" },
    ]
    const denied: TraceEntry[] = [
      { kind: "approval-denied", toolName: "fetch_url" },
    ]
    expect(projectTraceForChatDisplay(waiting, RunStatus.WaitingForApproval)).toEqual([
      { kind: "approval-wait", toolName: "fetch_url", reason: "b" },
    ])
    expect(projectTraceForChatDisplay(denied, RunStatus.Cancelled)).toEqual([])
    expect(projectTraceForChatDisplay(waiting, RunStatus.Completed)).toEqual([])
  })
})
