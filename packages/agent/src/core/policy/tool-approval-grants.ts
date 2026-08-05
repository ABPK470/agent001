/**
 * Pure matching for operator tool-approval grants.
 *
 * Instance grants: tool name + normalized args (one call).
 * Run grants: tool name only (remainder of the resume chain).
 */

import { ToolApprovalGrantScope, type ToolApprovalGrantScope as GrantScope } from "../../domain/enums/tool-approval.js"
import type { HostedPolicyContext } from "../../domain/types/policy-context.js"
import type { Step } from "../../domain/types/run-models.js"
import { stripRuntimeToolArgs } from "@mia/shared-types"

export type ToolApprovalGrant = {
  grantId?: string
  toolName: string
  args: Record<string, unknown>
  /** Missing / unknown → instance (back-compat). */
  scope?: GrantScope
}

export function stableToolArgsKey(args: Record<string, unknown>): string {
  return JSON.stringify(stripRuntimeToolArgs(args))
}

export function resolveGrantScope(grant: Pick<ToolApprovalGrant, "scope">): GrantScope {
  return grant.scope === ToolApprovalGrantScope.Run
    ? ToolApprovalGrantScope.Run
    : ToolApprovalGrantScope.Instance
}

export function grantAllowsToolStep(
  grant: ToolApprovalGrant,
  toolName: string,
  args: Record<string, unknown>,
): boolean {
  if (grant.toolName !== toolName) return false
  if (resolveGrantScope(grant) === ToolApprovalGrantScope.Run) return true
  return stableToolArgsKey(grant.args) === stableToolArgsKey(args)
}

export function hasToolApprovalGrant(
  ctx: HostedPolicyContext | null | undefined,
  step: Step,
): boolean {
  const grants = ctx?.toolApprovalGrants
  if (!grants?.length) return false
  return grants.some((grant) => grantAllowsToolStep(grant, step.action, step.input))
}
