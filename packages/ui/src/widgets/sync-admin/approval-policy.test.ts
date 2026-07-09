import { describe, expect, it } from "vitest"
import { approvalRequired, defaultApprovalPolicy, resolveApprovalPolicy } from "./approval-policy"

describe("resolveApprovalPolicy", () => {
  const policies = [
    { targetEnv: "dev", riskTier: "low", policy: "single" as const },
    { targetEnv: "prod", riskTier: "medium", policy: "dual" as const },
  ]

  it("uses stored policy for exact target + tier match", () => {
    expect(resolveApprovalPolicy(policies, "dev", "low")).toBe("single")
    expect(resolveApprovalPolicy(policies, "prod", "medium")).toBe("dual")
  })

  it("falls back to platform defaults when no row exists", () => {
    expect(resolveApprovalPolicy(policies, "dev", "medium")).toBe("single")
    expect(resolveApprovalPolicy(policies, "uat", "low")).toBe("none")
    expect(resolveApprovalPolicy(policies, "uat", null)).toBe("none")
    expect(resolveApprovalPolicy(policies, "prod", "high")).toBe("dual")
  })

  it("flags when approval is required", () => {
    expect(approvalRequired(defaultApprovalPolicy("low"))).toBe(false)
    expect(approvalRequired(defaultApprovalPolicy("medium"))).toBe(true)
  })
})
