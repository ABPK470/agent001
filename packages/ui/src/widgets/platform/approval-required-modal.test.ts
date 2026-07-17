import { describe, expect, it } from "vitest"
import { pendingApprovalFromEvent } from "../../state/pending-approval"

describe("pendingApprovalFromEvent", () => {
  it("maps approval.required SSE payload into pending modal state", () => {
    const pending = pendingApprovalFromEvent({
      approvalId: "appr-1",
      runId: "run-1",
      stepId: "step-1",
      toolName: "fetch_url",
      reason: "outbound network needs approval",
      policyName: "approve_fetch",
      args: { url: "https://example.com" },
    })

    expect(pending).toEqual({
      approvalId: "appr-1",
      runId: "run-1",
      stepId: "step-1",
      toolName: "fetch_url",
      reason: "outbound network needs approval",
      policyName: "approve_fetch",
      args: { url: "https://example.com" },
      notificationId: null,
    })
  })

  it("fills defaults when optional fields are missing", () => {
    const pending = pendingApprovalFromEvent({ runId: "run-2" })
    expect(pending.approvalId).toBeNull()
    expect(pending.toolName).toBe("unknown")
    expect(pending.reason).toBe("Policy requires approval")
    expect(pending.notificationId).toBeNull()
  })
})
