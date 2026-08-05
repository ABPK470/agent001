import { describe, expect, it } from "vitest"
import {
  formatApprovalDeniedCancelDetail,
  formatApprovalDeniedLabel,
  formatApprovalWaitLabel,
  normalizeApprovalDeniedReason,
} from "./approval-copy"

describe("approval copy", () => {
  it("normalizes an empty denial reason", () => {
    expect(normalizeApprovalDeniedReason(null)).toBe("")
    expect(normalizeApprovalDeniedReason("   ")).toBe("")
  })

  it("formats approval state from structured fields", () => {
    expect(formatApprovalWaitLabel("fetch_url", "network")).toBe(
      "Paused for approval — fetch_url: network",
    )
    expect(formatApprovalDeniedLabel("fetch_url", "operator denied")).toBe(
      "Approval denied — fetch_url: operator denied",
    )
    expect(formatApprovalDeniedCancelDetail("fetch_url", null)).toBe(
      "Tool approval denied for fetch_url.",
    )
  })
})
