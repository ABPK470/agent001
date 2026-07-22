/**
 * Shared policy context for agent tools and HTTP Sync.
 * One rail: always hosted runMode (default-deny). Role is identity only.
 * AGENT_HOSTED_MODE / workspace isolation is separate — not used here.
 */

import {
  PolicyRole,
  PolicyRunMode,
  type HostedPolicyContext,
} from "@mia/agent"

export function policyRoleFromAdmin(isAdmin: boolean): PolicyRole {
  return isAdmin ? PolicyRole.Admin : PolicyRole.HostedUser
}

export function buildPolicyContext(input: {
  runId: string
  role: PolicyRole
  actorUpn?: string | null
  sessionId?: string | null
  sandboxRoot?: string | null
  parentRunId?: string | null
  toolApprovalGrants?: HostedPolicyContext["toolApprovalGrants"]
}): HostedPolicyContext {
  return {
    runId: input.runId,
    parentRunId: input.parentRunId ?? null,
    /** Product governance is always default-deny — admin does not bypass Policies. */
    runMode: PolicyRunMode.Hosted,
    role: input.role,
    sandboxRoot: input.sandboxRoot ?? null,
    actorUpn: input.actorUpn ?? null,
    sessionId: input.sessionId ?? null,
    toolApprovalGrants: input.toolApprovalGrants,
  }
}
