/**
 * Shared policy context — always hosted runMode; role is identity only.
 */

import { PolicyRole, PolicyRunMode } from "@mia/agent"
import { describe, expect, it } from "vitest"
import {
  buildPolicyContext,
  policyRoleFromAdmin,
} from "../src/api/policies/service/policy-context.js"

describe("buildPolicyContext", () => {
  it("maps admin session to Admin role but always Hosted runMode", () => {
    const ctx = buildPolicyContext({
      runId: "r1",
      role: policyRoleFromAdmin(true),
      actorUpn: "admin@example.com",
    })
    expect(ctx.role).toBe(PolicyRole.Admin)
    expect(ctx.runMode).toBe(PolicyRunMode.Hosted)
  })

  it("maps non-admin to HostedUser with Hosted runMode", () => {
    const ctx = buildPolicyContext({
      runId: "r1",
      role: policyRoleFromAdmin(false),
      actorUpn: "user@example.com",
    })
    expect(ctx.role).toBe(PolicyRole.HostedUser)
    expect(ctx.runMode).toBe(PolicyRunMode.Hosted)
  })
})
