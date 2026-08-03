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
import { sql, type UpdateObject } from "kysely"
import type { PlatformDatabase } from "../../../schema/tables.js"
import { getPlatformDb } from "../../../schema/kysely.js"
import { runAll, runChanges, runExec, runGet } from "../../../schema/execute.js"

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

export function upsertApprovalPolicy(p: ApprovalPolicy, actor: string): void {
  const approversJson = JSON.stringify(p.approvers)
  const compiled = getPlatformDb()
    .insertInto("approval_configs")
    .values({
      tenant_id: p.tenantId,
      target_env: p.targetEnv,
      risk_tier: p.riskTier,
      policy: p.policy,
      approvers_json: approversJson,
      bypass_role: p.bypassRole,
      updated_at: sql`datetime('now')`,
      updated_by: actor,
    })
    .onConflict((oc) =>
      oc.columns(["tenant_id", "target_env", "risk_tier"]).doUpdateSet({
        policy: p.policy,
        approvers_json: approversJson,
        bypass_role: p.bypassRole,
        updated_at: sql`datetime('now')`,
        updated_by: actor,
      }),
    )
    .compile()
  runExec(compiled)
}

export function getApprovalPolicy(tenantId: string, targetEnv: string, tier: RiskTier): ApprovalPolicy {
  const compiled = getPlatformDb()
    .selectFrom("approval_configs")
    .selectAll()
    .where("tenant_id", "=", tenantId)
    .where("target_env", "=", targetEnv)
    .where("risk_tier", "=", tier)
    .compile()
  const row = runGet<ApprovalPolicyRow>(compiled)
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

export function listApprovalPolicies(tenantId: string): ApprovalPolicy[] {
  const compiled = getPlatformDb()
    .selectFrom("approval_configs")
    .selectAll()
    .where("tenant_id", "=", tenantId)
    .orderBy("target_env")
    .orderBy("risk_tier")
    .compile()
  const rows = runAll<ApprovalPolicyRow>(compiled)
  return rows.map((row) => ({
    tenantId: row.tenant_id,
    targetEnv: row.target_env,
    riskTier: row.risk_tier,
    policy: row.policy,
    approvers: JSON.parse(row.approvers_json) as string[],
    bypassRole: row.bypass_role
  }))
}

export function deleteApprovalPolicy(
  tenantId: string,
  targetEnv: string,
  riskTier: RiskTier
): boolean {
  const compiled = getPlatformDb()
    .deleteFrom("approval_configs")
    .where("tenant_id", "=", tenantId)
    .where("target_env", "=", targetEnv)
    .where("risk_tier", "=", riskTier)
    .compile()
  return runChanges(compiled) > 0
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

export function createApproval(i: CreateApprovalInput): ApprovalRow {
  const id = randomUUID()
  const expiresAt = new Date(Date.now() + i.ttlMs).toISOString()
  const compiled = getPlatformDb()
    .insertInto("sync_approvals")
    .values({
      id,
      proposal_id: i.proposalId,
      tenant_id: i.tenantId,
      requested_by: i.requestedBy,
      requested_at: sql`datetime('now')`,
      expires_at: expiresAt,
      policy: i.policy,
      state: "pending",
      plan_id_at_request: i.planId,
      plan_hash_at_request: i.planHash,
    })
    .compile()
  runExec(compiled)
  return getApproval(id)!
}

export function getApproval(id: string): ApprovalRow | null {
  const compiled = getPlatformDb()
    .selectFrom("sync_approvals")
    .selectAll()
    .where("id", "=", id)
    .compile()
  return runGet<ApprovalRow>(compiled) ?? null
}

export function listApprovals(filter: {
  tenantId: string
  state?: string
  proposalId?: string
  limit?: number
}): ApprovalRow[] {
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
  return runAll<ApprovalRow>(compiled)
}

export function findActiveApprovalForProposal(proposalId: string): ApprovalRow | null {
  const compiled = getPlatformDb()
    .selectFrom("sync_approvals")
    .selectAll()
    .where("proposal_id", "=", proposalId)
    .where("state", "in", ["pending", "partially_granted"])
    .orderBy("requested_at", "desc")
    .limit(1)
    .compile()
  return runGet<ApprovalRow>(compiled) ?? null
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

function updateApprovalById(
  id: string,
  patch: UpdateObject<PlatformDatabase, "sync_approvals">,
): void {
  const compiled = getPlatformDb()
    .updateTable("sync_approvals")
    .set(patch)
    .where("id", "=", id)
    .compile()
  runExec(compiled)
}

/** Atomically advance the approval state machine on a grant action. */
export function grantApproval(i: GrantApprovalInput): ApprovalRow {
  const row = getApproval(i.approvalId)
  if (!row) throw new ApprovalError("not_found", `Approval ${i.approvalId} not found`)
  if (row.state !== "pending" && row.state !== "partially_granted") {
    throw new ApprovalError("wrong_state", `Approval is ${row.state}`)
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    updateApprovalById(i.approvalId, { state: "expired" })
    throw new ApprovalError("expired", "Approval window has closed")
  }
  if (i.approver === row.requested_by) {
    throw new ApprovalError("self_grant", "Requester cannot approve their own proposal")
  }
  if (i.approver === row.granted_by_1) {
    throw new ApprovalError("duplicate_grant", "Approver already granted")
  }

  if (row.policy === "single") {
    updateApprovalById(i.approvalId, {
      state: "granted",
      granted_by_1: i.approver,
      granted_at_1: sql`datetime('now')`,
    })
  } else if (row.policy === "dual") {
    if (!row.granted_by_1) {
      updateApprovalById(i.approvalId, {
        state: "partially_granted",
        granted_by_1: i.approver,
        granted_at_1: sql`datetime('now')`,
      })
    } else {
      updateApprovalById(i.approvalId, {
        state: "granted",
        granted_by_2: i.approver,
        granted_at_2: sql`datetime('now')`,
      })
    }
  } else {
    // 'none' policies should never reach the grant route — guard anyway.
    updateApprovalById(i.approvalId, { state: "granted" })
  }
  return getApproval(i.approvalId)!
}

export function rejectApproval(approvalId: string, rejector: string, reason: string): ApprovalRow {
  const row = getApproval(approvalId)
  if (!row) throw new ApprovalError("not_found", `Approval ${approvalId} not found`)
  if (row.state !== "pending" && row.state !== "partially_granted") {
    throw new ApprovalError("wrong_state", `Approval is ${row.state}`)
  }
  updateApprovalById(approvalId, {
    state: "rejected",
    rejected_by: rejector,
    rejected_at: sql`datetime('now')`,
    reject_reason: reason,
  })
  return getApproval(approvalId)!
}

export function bypassApproval(approvalId: string, actor: string, reason: string): ApprovalRow {
  const row = getApproval(approvalId)
  if (!row) throw new ApprovalError("not_found", `Approval ${approvalId} not found`)
  if (row.state === "granted" || row.state === "bypassed") return row
  updateApprovalById(approvalId, {
    state: "bypassed",
    bypass_by: actor,
    bypass_reason: reason,
  })
  return getApproval(approvalId)!
}

export function expireDueApprovals(): number {
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
  return runChanges(compiled)
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

export function issueApprovalToken(i: IssueTokenInput): IssuedToken {
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
      issued_at: sql`datetime('now')`,
      expires_at: expiresAt,
    })
    .compile()
  runExec(compiled)
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

export function consumeApprovalToken(i: ConsumeTokenInput): ConsumedToken {
  const tokenHash = sha256Hex(hmacSha256Hex(i.secret, i.raw))
  const compiled = getPlatformDb()
    .selectFrom("sync_approval_tokens")
    .select(["approval_id", "action", "issued_to", "expires_at", "used_at"])
    .where("token_hash", "=", tokenHash)
    .compile()
  const row = runGet<{
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
    .set({ used_at: sql`datetime('now')`, used_by: i.by })
    .where("token_hash", "=", tokenHash)
    .compile()
  runExec(markUsed)
  return { approvalId: row.approval_id, action: row.action, issuedTo: row.issued_to }
}
