import { describe, expect, it } from "vitest"
import { formatApprovalWaitLabel, parseApprovalWaitMessage } from "./approval-wait-copy"

describe("approval-wait-copy", () => {
  it("parses waiting-for-approval trace lines", () => {
    expect(parseApprovalWaitMessage("Waiting for approval — sync_execute: prod write")).toEqual({
      tool: "sync_execute",
      reason: "prod write",
    })
  })

  it("formats paused label for chat", () => {
    expect(formatApprovalWaitLabel("fetch_url", "network")).toBe(
      "Paused for approval — fetch_url: network",
    )
  })
})
