import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { ToolApprovalGrantScope } from "@mia/shared-enums"
import {
  pendingApprovalFromEvent,
  pendingApprovalFromNotification,
} from "../../state/pending-approval"

const here = dirname(fileURLToPath(import.meta.url))
const modalSrc = readFileSync(join(here, "ApprovalRequiredModal.tsx"), "utf8")

describe("ApprovalRequiredModal grant scopes", () => {
  it("offers instance and run approve paths plus decide later and deny", () => {
    expect(modalSrc).toContain("Approve this call")
    expect(modalSrc).toContain("Approve for this run")
    expect(modalSrc).toContain("Decide later")
    expect(modalSrc).toContain("Deny")
    expect(modalSrc).toContain("ToolApprovalGrantScope.Instance")
    expect(modalSrc).toContain("ToolApprovalGrantScope.Run")
    expect(modalSrc).toContain('approveRunToolStep(pending.approvalId, { scope })')
    expect(ToolApprovalGrantScope.Instance).toBe("instance")
    expect(ToolApprovalGrantScope.Run).toBe("run")
  })
})

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

  it("rejects malformed approval events", () => {
    expect(pendingApprovalFromEvent({ runId: "run-2" })).toBeNull()
  })
})

describe("pendingApprovalFromNotification", () => {
  it("rejects notifications without a complete approval action", () => {
    expect(
      pendingApprovalFromNotification({
        id: "note-1",
        runId: "run-1",
        stepId: "step-1",
        actions: [{
          action: "deny-run-step",
          data: { approvalId: "approval-1" },
        }],
      }),
    ).toBeNull()
  })
})
