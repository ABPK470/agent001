import { describe, expect, it } from "vitest"
import { ToolApprovalGrantScope } from "../src/domain/enums/tool-approval.js"
import {
  grantAllowsToolStep,
  hasToolApprovalGrant,
  resolveGrantScope,
  stableToolArgsKey,
} from "../src/core/policy/tool-approval-grants.js"
import type { HostedPolicyContext } from "../src/domain/types/policy-context.js"
import type { Step } from "../src/domain/types/run-models.js"

function step(action: string, input: Record<string, unknown>): Step {
  return {
    id: "s1",
    definitionId: "s1",
    name: action,
    action,
    input,
    condition: null,
    onError: "fail",
    status: "pending" as Step["status"],
    order: 0,
    output: {},
    error: null,
    startedAt: null,
    completedAt: null,
  }
}

function ctx(grants: HostedPolicyContext["toolApprovalGrants"]): HostedPolicyContext {
  return {
    runId: "run-1",
    runMode: "hosted",
    role: "hosted_user",
    sandboxRoot: "/tmp",
    toolApprovalGrants: grants,
  }
}

describe("tool-approval-grants", () => {
  it("defaults missing scope to instance", () => {
    expect(resolveGrantScope({})).toBe(ToolApprovalGrantScope.Instance)
    expect(resolveGrantScope({ scope: ToolApprovalGrantScope.Run })).toBe(ToolApprovalGrantScope.Run)
  })

  it("instance grant matches tool + normalized args only", () => {
    const grant = {
      toolName: "fetch_url",
      args: { url: "https://a.example" },
      scope: ToolApprovalGrantScope.Instance,
    }
    expect(grantAllowsToolStep(grant, "fetch_url", { url: "https://a.example" })).toBe(true)
    expect(grantAllowsToolStep(grant, "fetch_url", { url: "https://b.example" })).toBe(false)
    expect(grantAllowsToolStep(grant, "write_file", { url: "https://a.example" })).toBe(false)
  })

  it("run grant matches tool name for any args", () => {
    const grant = {
      toolName: "fetch_url",
      args: { url: "https://a.example" },
      scope: ToolApprovalGrantScope.Run,
    }
    expect(grantAllowsToolStep(grant, "fetch_url", { url: "https://b.example" })).toBe(true)
    expect(grantAllowsToolStep(grant, "write_file", { path: "/x" })).toBe(false)
  })

  it("hasToolApprovalGrant uses scope rules against the step", () => {
    const hosted = ctx([
      {
        grantId: "g1",
        toolName: "fetch_url",
        args: { url: "https://a.example" },
        scope: ToolApprovalGrantScope.Run,
      },
    ])
    expect(hasToolApprovalGrant(hosted, step("fetch_url", { url: "https://other" }))).toBe(true)
    expect(hasToolApprovalGrant(hosted, step("sync_execute", {}))).toBe(false)
  })

  it("stableToolArgsKey strips planner-trace runtime keys consistently", () => {
    expect(stableToolArgsKey({ url: "https://x", __plannerTrace: { step: 1 } })).toBe(
      stableToolArgsKey({ url: "https://x" }),
    )
  })
})
