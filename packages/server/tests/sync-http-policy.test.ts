/**
 * HTTP Sync policy gate — deny / require approval / grant retry.
 */

import {
  PolicyEffect,
  PolicyRole,
  PolicyRunMode,
  RulePolicyEvaluator,
  type AgentRun,
} from "@mia/agent"
import { beforeEach, describe, expect, it, vi } from "vitest"

const listPolicyRules = vi.fn(() => [] as Array<{
  name: string
  effect: string
  condition: string
  parameters: string
}>)
const listApprovedSyncToolGrants = vi.fn(() => [] as Array<{
  grantId: string
  toolName: string
  args: Record<string, unknown>
}>)
const upsertPendingSyncToolApproval = vi.fn((input: {
  actorUpn: string
  toolName: string
  args: Record<string, unknown>
  reason: string
  policyName: string
}) => ({
  id: "approval-1",
  actorUpn: input.actorUpn,
  toolName: input.toolName,
  args: input.args,
  argsKey: "{}",
  reason: input.reason,
  policyName: input.policyName,
  status: "pending" as const,
  requestedAt: new Date().toISOString(),
  resolvedAt: null,
  resolvedBy: null,
}))
const consumeSyncToolApprovalGrant = vi.fn()

vi.mock("../src/infra/persistence/sqlite.js", () => ({
  listPolicyRules: (...args: unknown[]) => listPolicyRules(...args),
}))

vi.mock("../src/infra/persistence/db/sync-tool-approvals.js", () => ({
  listApprovedSyncToolGrants: (...args: unknown[]) => listApprovedSyncToolGrants(...args),
  upsertPendingSyncToolApproval: (...args: unknown[]) => upsertPendingSyncToolApproval(...(args as [never])),
  consumeSyncToolApprovalGrant: (...args: unknown[]) => consumeSyncToolApprovalGrant(...args),
  syncToolArgsKey: (args: Record<string, unknown>) => JSON.stringify(args),
}))

import {
  assertSyncHttpPolicy,
  SyncHttpPolicyDeniedError,
} from "../src/api/sync/service/sync-http-policy.js"

const session = {
  sid: "s1",
  upn: "user@example.com",
  displayName: "User",
  isAdmin: false,
  ip: "127.0.0.1",
  userAgent: "test",
}

function dbRule(name: string, effect: string, parameters: Record<string, unknown>) {
  return {
    name,
    effect,
    condition: "selectors",
    parameters: JSON.stringify(parameters),
  }
}

describe("assertSyncHttpPolicy", () => {
  beforeEach(() => {
    listPolicyRules.mockReset()
    listApprovedSyncToolGrants.mockReset()
    upsertPendingSyncToolApproval.mockClear()
    consumeSyncToolApprovalGrant.mockClear()
    listApprovedSyncToolGrants.mockReturnValue([])
  })

  it("allows sync_preview when hosted allow rule matches", async () => {
    listPolicyRules.mockReturnValue([
      dbRule("hosted_allow_sync_preview", PolicyEffect.Allow, {
        selectors: { role: PolicyRole.HostedUser, tool: "sync_preview" },
      }),
    ])
    await expect(
      assertSyncHttpPolicy({
        session,
        toolName: "sync_preview",
        args: { source: "dev", target: "uat", entityType: "content", entityId: 1 },
      }),
    ).resolves.toBeUndefined()
  })

  it("denies when a deny rule matches", async () => {
    listPolicyRules.mockReturnValue([
      dbRule("deny_sync_execute", PolicyEffect.Deny, {
        reason: "no execute",
        selectors: { tool: "sync_execute" },
      }),
    ])
    await expect(
      assertSyncHttpPolicy({
        session,
        toolName: "sync_execute",
        args: { planId: "p1", confirm: true, target: "prod" },
      }),
    ).rejects.toBeInstanceOf(SyncHttpPolicyDeniedError)
  })

  it("requires approval and persists a pending grant", async () => {
    listPolicyRules.mockReturnValue([
      dbRule("hosted_require_approval_sync_execute", PolicyEffect.RequireApproval, {
        reason: "confirm execute",
        selectors: { role: PolicyRole.HostedUser, tool: "sync_execute" },
      }),
    ])
    await expect(
      assertSyncHttpPolicy({
        session,
        toolName: "sync_execute",
        args: { planId: "p1", confirm: true, target: "prod" },
      }),
    ).rejects.toMatchObject({
      code: "approval_required",
      approvalId: "approval-1",
    })
    expect(upsertPendingSyncToolApproval).toHaveBeenCalled()
  })

  it("allows after an approved grant matches args", async () => {
    const args = { planId: "p1", confirm: true, target: "prod" }
    listApprovedSyncToolGrants.mockReturnValue([
      { grantId: "g1", toolName: "sync_execute", args },
    ])
    listPolicyRules.mockReturnValue([
      dbRule("hosted_require_approval_sync_execute", PolicyEffect.RequireApproval, {
        reason: "confirm execute",
        selectors: { role: PolicyRole.HostedUser, tool: "sync_execute" },
      }),
    ])
    await expect(
      assertSyncHttpPolicy({ session, toolName: "sync_execute", args }),
    ).resolves.toBeUndefined()
    expect(consumeSyncToolApprovalGrant).toHaveBeenCalledWith("g1")
  })
})

describe("RulePolicyEvaluator sync facts (smoke)", () => {
  it("require_approval matches sync_execute with target prod via dbEnvironment", async () => {
    const ev = new RulePolicyEvaluator()
    ev.addRule({
      name: "approve_prod_sync",
      effect: PolicyEffect.RequireApproval,
      condition: "selectors",
      parameters: {
        reason: "prod sync",
        selectors: { tool: "sync_execute", dbEnvironment: "prod" },
      },
    })
    const approval = await ev.evaluatePreStep(
      { id: "r1" } as AgentRun,
      {
        id: "s1",
        definitionId: "s1",
        name: "sync_execute",
        action: "sync_execute",
        input: { planId: "p1", target: "prod", confirm: true },
        condition: null,
        onError: "fail",
        status: "pending",
        order: 0,
        output: {},
        error: null,
        startedAt: null,
        completedAt: null,
      },
      {
        runId: "r1",
        runMode: PolicyRunMode.Hosted,
        role: PolicyRole.HostedUser,
        sandboxRoot: null,
      },
    )
    expect(approval).toMatch(/approve_prod_sync/)
  })
})
