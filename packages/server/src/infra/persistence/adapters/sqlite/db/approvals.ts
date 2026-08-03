/**
 * F1.7 — Approval workflow: persistence + HMAC tokens + plan-drift guard.
 *
 *   approval_configs     per (tenant, target_env, risk_tier) → none/single/dual
 *   sync_approvals        per proposal: state-machine + audit columns
 *   sync_approval_tokens  one-click HMAC URLs (stored hashed)
 *
 * The state machine here mirrors the F1.7 contract:
 *   pending → partially_granted → granted   (dual policy after one)
 *   pending → granted                       (single policy)
 *   pending → rejected | expired | bypassed | cancelled
 *
 * `bypass` requires the requester to hold the policy.bypass_role; the
 * route handler is responsible for enforcing the role check before
 * invoking `bypassApproval`.
 */

import { hmacSha256Hex, RiskTier, sha256Hex } from "@mia/sync"
import { randomBytes, randomUUID } from "node:crypto"
import type { UpdateObject } from "kysely"
import type { PlatformDatabase } from "../../../schema/tables.js"
import { getPlatformDb } from "../../../schema/kysely.js"
import { runAllAsync, runChangesAsync, runExecAsync, runGetAsync } from "../../../schema/execute-async.js"
import { platformNow } from "../../../schema/sql-time.js"
import { upsertRowAsync } from "../../../schema/upsert.js"

// ── policies ────────────────────────────────────────────────────

export const ApprovalPolicyKind = {
  None: "none",
  Single: "single",
  Dual: "dual"
} as const
export type ApprovalPolicyKind = (typeof ApprovalPolicyKind)[keyof typeof ApprovalPolicyKind]

export interface ApprovalPolicyRow {
  tenant_id: string
  target_env: string
  risk_tier: RiskTier
  policy: ApprovalPolicyKind
  approvers_json: string
  bypass_role: string | null
  updated_at: string
  updated_by: string
}

export interface ApprovalPolicy {
  tenantId: string
  targetEnv: string
  riskTier: RiskTier
  policy: ApprovalPolicyKind
  approvers: readonly string[]
  bypassRole: string | null
}

export async function upsertApprovalPolicy(p: ApprovalPolicy, actor: string): Promise<void> {
  const approversJson = JSON.stringify(p.approvers)
  const now = platformNow()
  await upsertRowAsync({
    table: "approval_configs",
    keys: {
      tenant_id: p.tenantId,
      target_env: p.targetEnv,
      risk_tier: p.riskTier,
    },
    insert: {
      tenant_id: p.tenantId,
      target_env: p.targetEnv,
      risk_tier: p.riskTier,
      policy: p.policy,
      approvers_json: approversJson,
      bypass_role: p.bypassRole,
      updated_at: now,
      updated_by: actor,
    },
    update: {
      policy: p.policy,
      approvers_json: approversJson,
      bypass_role: p.bypassRole,
      updated_at: now,
      updated_by: actor,
    },
  })
}

export async function getApprovalPolicy(tenantId: string, targetEnv: string, tier: RiskTier): Promise<ApprovalPolicy> {
  const compiled = getPlatformDb()
    .selectFrom("approval_configs")
    .selectAll()
    .where("tenant_id", "=", tenantId)
    .where("target_env", "=", targetEnv)
    .where("risk_tier", "=", tier)
    .compile()
  const row = await runGetAsync<ApprovalPolicyRow>(compiled)
  if (row) {
    return {
      tenantId: row.tenant_id,
      targetEnv: row.target_env,
      riskTier: row.risk_tier,
      policy: row.policy,
      approvers: JSON.parse(row.approvers_json) as string[],
      bypassRole: row.bypass_role
    }
  }
  // Sensible defaults: low → none, medium → single, high/critical → dual.
  // Approvers list is empty → the route enforces "any non-self upn"
  // when the list is empty. bypassRole defaults to 'admin'.
  const defaultPolicy: ApprovalPolicyKind = tier === "low" ? "none" : tier === "medium" ? "single" : "dual"
  return {
    tenantId,
    targetEnv,
    riskTier: tier,
    policy: defaultPolicy,
    approvers: [],
    bypassRole: "admin"
  }
}

export async function listApprovalPolicies(tenantId: string): Promise<ApprovalPolicy[]> {
  const compiled = getPlatformDb()
    .selectFrom("approval_configs")
    .selectAll()
    .where("tenant_id", "=", tenantId)
    .orderBy("target_env")
    .orderBy("risk_tier")
    .compile()
  const rows = await runAllAsync<ApprovalPolicyRow>(compiled)
  return rows.map((row) => ({
    tenantId: row.tenant_id,
    targetEnv: row.target_env,
    riskTier: row.risk_tier,
    policy: row.policy,
    approvers: JSON.parse(row.approvers_json) as string[],
    bypassRole: row.bypass_role
  }))
}

export async function deleteApprovalPolicy(
  tenantId: string,
  targetEnv: string,
  riskTier: RiskTier
): Promise<boolean> {
  const compiled = getPlatformDb()
    .deleteFrom("approval_configs")
    .where("tenant_id", "=", tenantId)
    .where("target_env", "=", targetEnv)
    .where("risk_tier", "=", riskTier)
    .compile()
  return await runChangesAsync(compiled) > 0
}

// ── approvals ────────────────────────────────────────────────────

export const ApprovalState = {
  Pending: "pending",
  PartiallyGranted: "partially_granted",
  Granted: "granted",
  Rejected: "rejected",
  Expired: "expired",
  Bypassed: "bypassed",
  Cancelled: "cancelled"
} as const
export type ApprovalState = (typeof ApprovalState)[keyof typeof ApprovalState]

export interface ApprovalRow {
  id: string
  proposal_id: string
  tenant_id: string
  requested_by: string
  requested_at: string
  expires_at: string
  policy: ApprovalPolicyKind
  state: ApprovalState
  granted_by_1: string | null
  granted_at_1: string | null
  granted_by_2: string | null
  granted_at_2: string | null
  rejected_by: string | null
  rejected_at: string | null
  reject_reason: string | null
  bypass_by: string | null
  bypass_reason: string | null
  plan_id_at_request: string | null
  plan_hash_at_request: string | null
}

export interface CreateApprovalInput {
  proposalId: string
  tenantId: string
  requestedBy: string
  policy: ApprovalPolicyKind
  ttlMs: number
  planId: string | null
  planHash: string | null
}

export async function createApproval(i: CreateApprovalInput): Promise<ApprovalRow> {
  const id = randomUUID()
  const expiresAt = new Date(Date.now() + i.ttlMs).toISOString()
  const compiled = getPlatformDb()
    .insertInto("sync_approvals")
    .values({
      id,
      proposal_id: i.proposalId,
      tenant_id: i.tenantId,
      requested_by: i.requestedBy,
      requested_at: platformNow(),
      expires_at: expiresAt,
      policy: i.policy,
      state: "pending",
      plan_id_at_request: i.planId,
      plan_hash_at_request: i.planHash,
    })
    .compile()
  await runExecAsync(compiled)
  const approval = await getApproval(id)
  if (!approval) throw new Error(`Approval ${id} missing after insert`)
  return approval
}

export async function getApproval(id: string): Promise<ApprovalRow | null> {
  const compiled = getPlatformDb()
    .selectFrom("sync_approvals")
    .selectAll()
    .where("id", "=", id)
    .compile()
  return await runGetAsync<ApprovalRow>(compiled) ?? null
}

export async function listApprovals(filter: {
  tenantId: string
  state?: string
  proposalId?: string
  limit?: number
}): Promise<ApprovalRow[]> {
  let query = getPlatformDb()
    .selectFrom("sync_approvals")
    .selectAll()
    .where("tenant_id", "=", filter.tenantId)
  if (filter.state) {
    query = query.where("state", "=", filter.state)
  }
  if (filter.proposalId) {
    query = query.where("proposal_id", "=", filter.proposalId)
  }
  const compiled = query
    .orderBy("requested_at", "desc")
    .limit(filter.limit ?? 500)
    .compile()
  return await runAllAsync<ApprovalRow>(compiled)
}

export async function findActiveApprovalForProposal(proposalId: string): Promise<ApprovalRow | null> {
  const compiled = getPlatformDb()
    .selectFrom("sync_approvals")
    .selectAll()
    .where("proposal_id", "=", proposalId)
    .where("state", "in", ["pending", "partially_granted"])
    .orderBy("requested_at", "desc")
    .limit(1)
    .compile()
  return await runGetAsync<ApprovalRow>(compiled) ?? null
}

export class ApprovalError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message)
  }
}

export interface GrantApprovalInput {
  approvalId: string
  approver: string
  /** Set by the route after revalidating plan drift; logged into audit. */
  planHashAtGrant: string | null
}

async function updateApprovalById(
  id: string,
  patch: UpdateObject<PlatformDatabase, "sync_approvals">,
): Promise<void> {
  const compiled = getPlatformDb()
    .updateTable("sync_approvals")
    .set(patch)
    .where("id", "=", id)
    .compile()
  await runExecAsync(compiled)
}

/** Atomically advance the approval state machine on a grant action. */
export async function grantApproval(i: GrantApprovalInput): Promise<ApprovalRow> {
  const row = await getApproval(i.approvalId)
  if (!row) throw new ApprovalError("not_found", `Approval ${i.approvalId} not found`)
  if (row.state !== "pending" && row.state !== "partially_granted") {
    throw new ApprovalError("wrong_state", `Approval is ${row.state}`)
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await updateApprovalById(i.approvalId, { state: "expired" })
    throw new ApprovalError("expired", "Approval window has closed")
  }
  if (i.approver === row.requested_by) {
    throw new ApprovalError("self_grant", "Requester cannot approve their own proposal")
  }
  if (i.approver === row.granted_by_1) {
    throw new ApprovalError("duplicate_grant", "Approver already granted")
  }

  if (row.policy === "single") {
    await updateApprovalById(i.approvalId, {
      state: "granted",
      granted_by_1: i.approver,
      granted_at_1: platformNow(),
    })
  } else if (row.policy === "dual") {
    if (!row.granted_by_1) {
      await updateApprovalById(i.approvalId, {
        state: "partially_granted",
        granted_by_1: i.approver,
        granted_at_1: platformNow(),
      })
    } else {
      await updateApprovalById(i.approvalId, {
        state: "granted",
        granted_by_2: i.approver,
        granted_at_2: platformNow(),
      })
    }
  } else {
    // 'none' policies should never reach the grant route — guard anyway.
    await updateApprovalById(i.approvalId, { state: "granted" })
  }
  return (await getApproval(i.approvalId))!
}

export async function rejectApproval(approvalId: string, rejector: string, reason: string): Promise<ApprovalRow> {
  const row = await getApproval(approvalId)
  if (!row) throw new ApprovalError("not_found", `Approval ${approvalId} not found`)
  if (row.state !== "pending" && row.state !== "partially_granted") {
    throw new ApprovalError("wrong_state", `Approval is ${row.state}`)
  }
  await updateApprovalById(approvalId, {
    state: "rejected",
    rejected_by: rejector,
    rejected_at: platformNow(),
    reject_reason: reason,
  })
  return (await getApproval(approvalId))!
}

export async function bypassApproval(approvalId: string, actor: string, reason: string): Promise<ApprovalRow> {
  const row = await getApproval(approvalId)
  if (!row) throw new ApprovalError("not_found", `Approval ${approvalId} not found`)
  if (row.state === "granted" || row.state === "bypassed") return row
  await updateApprovalById(approvalId, {
    state: "bypassed",
    bypass_by: actor,
    bypass_reason: reason,
  })
  return (await getApproval(approvalId))!
}

export async function expireDueApprovals(): Promise<number> {
  // `expires_at` is stored as a JS ISO-8601 string ("…T…Z"). SQLite's
  // `datetime('now')` returns "YYYY-MM-DD HH:MM:SS" which, under text
  // comparison, sorts *before* any 'T'-shaped ISO string — so a naïve
  // `< datetime('now')` never matches. Pass the current ISO timestamp
  // explicitly so the comparison stays text-lexicographic on a uniform
  // format.
  const compiled = getPlatformDb()
    .updateTable("sync_approvals")
    .set({ state: "expired" })
    .where("state", "in", ["pending", "partially_granted"])
    .where("expires_at", "<", new Date().toISOString())
    .compile()
  return await runChangesAsync(compiled)
}

// ── one-click tokens ─────────────────────────────────────────────

export interface IssueTokenInput {
  approvalId: string
  action: "grant" | "reject"
  issuedTo: string
  ttlMs: number
  secret: string
}

export interface IssuedToken {
  /** Raw token to embed in the URL. Never store this directly. */
  raw: string
  expiresAt: string
}

export async function issueApprovalToken(i: IssueTokenInput): Promise<IssuedToken> {
  const raw = randomBytes(32).toString("base64url")
  const tokenHash = sha256Hex(hmacSha256Hex(i.secret, raw))
  const expiresAt = new Date(Date.now() + i.ttlMs).toISOString()
  const compiled = getPlatformDb()
    .insertInto("sync_approval_tokens")
    .values({
      token_hash: tokenHash,
      approval_id: i.approvalId,
      action: i.action,
      issued_to: i.issuedTo,
      issued_at: platformNow(),
      expires_at: expiresAt,
    })
    .compile()
  await runExecAsync(compiled)
  return { raw, expiresAt }
}

export interface ConsumeTokenInput {
  raw: string
  secret: string
  by: string
}

export interface ConsumedToken {
  approvalId: string
  action: "grant" | "reject"
  issuedTo: string
}

export async function consumeApprovalToken(i: ConsumeTokenInput): Promise<ConsumedToken> {
  const tokenHash = sha256Hex(hmacSha256Hex(i.secret, i.raw))
  const compiled = getPlatformDb()
    .selectFrom("sync_approval_tokens")
    .select(["approval_id", "action", "issued_to", "expires_at", "used_at"])
    .where("token_hash", "=", tokenHash)
    .compile()
  const row = await runGetAsync<{
    approval_id: string
    action: "grant" | "reject"
    issued_to: string
    expires_at: string
    used_at: string | null
  }>(compiled)
  if (!row) throw new ApprovalError("token_invalid", "Unknown or invalid token")
  if (row.used_at) throw new ApprovalError("token_used", "Token has already been used")
  if (new Date(row.expires_at).getTime() < Date.now()) {
    throw new ApprovalError("token_expired", "Token has expired")
  }
  const markUsed = getPlatformDb()
    .updateTable("sync_approval_tokens")
    .set({ used_at: platformNow(), used_by: i.by })
    .where("token_hash", "=", tokenHash)
    .compile()
  await runExecAsync(markUsed)
  return { approvalId: row.approval_id, action: row.action, issuedTo: row.issued_to }
}
