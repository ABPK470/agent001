/**
 * HTTP Sync policy gate — same evaluatePreStep + buildPolicyContext as agent tools.
 */

import {
  PolicyViolationError,
  RulePolicyEvaluator,
  type AgentRun,
  type Step,
} from "@mia/agent"
import type { CurrentSession } from "../../../ports/session.js"
import * as db from "../../../infra/persistence/sqlite.js"
import {
  consumeSyncToolApprovalGrant,
  listApprovedSyncToolGrants,
  syncToolArgsKey,
  upsertPendingSyncToolApproval,
  type SyncToolApprovalRecord,
} from "../../../infra/persistence/db/sync-tool-approvals.js"
import {
  buildPolicyContext,
  policyRoleFromAdmin,
} from "../../policies/service/policy-context.js"

export const SYNC_POLICY_DENIED_CODE = "policy_denied" as const
export const SYNC_APPROVAL_REQUIRED_CODE = "approval_required" as const

export type SyncHttpTool = "sync_preview" | "sync_execute"

export class SyncHttpPolicyDeniedError extends Error {
  readonly code = SYNC_POLICY_DENIED_CODE
  readonly policyName: string
  readonly toolName: SyncHttpTool

  constructor(message: string, opts: { policyName: string; toolName: SyncHttpTool }) {
    super(message)
    this.name = "SyncHttpPolicyDeniedError"
    this.policyName = opts.policyName
    this.toolName = opts.toolName
  }
}

export class SyncHttpApprovalRequiredError extends Error {
  readonly code = SYNC_APPROVAL_REQUIRED_CODE
  readonly approvalId: string
  readonly policyName: string
  readonly toolName: SyncHttpTool
  readonly args: Record<string, unknown>

  constructor(
    message: string,
    opts: {
      approvalId: string
      policyName: string
      toolName: SyncHttpTool
      args: Record<string, unknown>
    },
  ) {
    super(message)
    this.name = "SyncHttpApprovalRequiredError"
    this.approvalId = opts.approvalId
    this.policyName = opts.policyName
    this.toolName = opts.toolName
    this.args = opts.args
  }
}

function makeStep(toolName: SyncHttpTool, args: Record<string, unknown>): Step {
  return {
    id: "sync-http",
    definitionId: "sync-http",
    name: toolName,
    action: toolName,
    input: args,
    condition: null,
    onError: "fail",
    status: "pending",
    order: 0,
    output: {},
    error: null,
    startedAt: null,
    completedAt: null,
  }
}

function loadEvaluator(): RulePolicyEvaluator {
  const ev = new RulePolicyEvaluator()
  for (const rule of db.listPolicyRules()) {
    ev.addRule({
      name: rule.name,
      effect: rule.effect,
      condition: rule.condition,
      parameters: rule.parameters ? JSON.parse(rule.parameters) : {},
    })
  }
  return ev
}

function parsePolicyName(approvalReason: string): string {
  const m = approvalReason.match(/^Policy '([^']+)'/)
  return m?.[1] ?? "policy"
}

/**
 * Assert Policies allow this HTTP Sync tool call.
 * On RequireApproval, persists a pending approval and throws.
 * On Allow with a matching grant, consumes the grant after evaluation passes.
 */
export async function assertSyncHttpPolicy(input: {
  session: CurrentSession
  toolName: SyncHttpTool
  args: Record<string, unknown>
}): Promise<void> {
  const { session, toolName, args } = input
  const step = makeStep(toolName, args)
  const actorUpn = session.upn
  const grants = listApprovedSyncToolGrants(actorUpn, toolName)
  const argsKey = syncToolArgsKey(args)
  const matching = grants.filter((g) => syncToolArgsKey(g.args) === argsKey)
  const ctx = buildPolicyContext({
    runId: `sync-http:${actorUpn}`,
    role: policyRoleFromAdmin(session.isAdmin),
    actorUpn,
    sessionId: session.sid,
    sandboxRoot: null,
    toolApprovalGrants: matching.length > 0 ? matching : undefined,
  })
  const evaluator = loadEvaluator()
  const dummyRun = { id: ctx.runId } as AgentRun

  let approval: string | null
  try {
    approval = await evaluator.evaluatePreStep(dummyRun, step, ctx)
  } catch (err) {
    if (err instanceof PolicyViolationError) {
      throw new SyncHttpPolicyDeniedError(err.message, {
        policyName: err.policyName,
        toolName,
      })
    }
    throw err
  }

  if (approval) {
    const policyName = parsePolicyName(approval)
    const pending: SyncToolApprovalRecord = upsertPendingSyncToolApproval({
      actorUpn: session.upn,
      toolName,
      args,
      reason: approval,
      policyName,
    })
    throw new SyncHttpApprovalRequiredError(approval, {
      approvalId: pending.id,
      policyName,
      toolName,
      args,
    })
  }

  const grant = ctx.toolApprovalGrants?.[0]
  if (grant) consumeSyncToolApprovalGrant(grant.grantId)
}

export function isSyncHttpPolicyDeniedError(e: unknown): e is SyncHttpPolicyDeniedError {
  return e instanceof SyncHttpPolicyDeniedError
}

export function isSyncHttpApprovalRequiredError(e: unknown): e is SyncHttpApprovalRequiredError {
  return e instanceof SyncHttpApprovalRequiredError
}
