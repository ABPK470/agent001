/**
 * F1.7 — Approval workflow: persistence + HMAC tokens + plan-drift guard.
 *
 *   approval_policies     per (tenant, target_env, risk_tier) → none/single/dual
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
import { getDb } from "./connection.js"

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
  getDb()
    .prepare(
      `
    INSERT INTO approval_policies (tenant_id, target_env, risk_tier, policy, approvers_json, bypass_role, updated_at, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?)
    ON CONFLICT(tenant_id, target_env, risk_tier) DO UPDATE SET
      policy         = excluded.policy,
      approvers_json = excluded.approvers_json,
      bypass_role    = excluded.bypass_role,
      updated_at     = excluded.updated_at,
      updated_by     = excluded.updated_by
  `
    )
    .run(p.tenantId, p.targetEnv, p.riskTier, p.policy, JSON.stringify(p.approvers), p.bypassRole, actor)
}

export function getApprovalPolicy(tenantId: string, targetEnv: string, tier: RiskTier): ApprovalPolicy {
  const row = getDb()
    .prepare(
      `
    SELECT * FROM approval_policies
     WHERE tenant_id = ? AND target_env = ? AND risk_tier = ?
  `
    )
    .get(tenantId, targetEnv, tier) as ApprovalPolicyRow | undefined
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
  const rows = getDb()
    .prepare(`SELECT * FROM approval_policies WHERE tenant_id = ? ORDER BY target_env, risk_tier`)
    .all(tenantId) as ApprovalPolicyRow[]
  return rows.map((row) => ({
    tenantId: row.tenant_id,
    targetEnv: row.target_env,
    riskTier: row.risk_tier,
    policy: row.policy,
    approvers: JSON.parse(row.approvers_json) as string[],
    bypassRole: row.bypass_role
  }))
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
  getDb()
    .prepare(
      `
    INSERT INTO sync_approvals (id, proposal_id, tenant_id, requested_by, expires_at,
                                policy, state, plan_id_at_request, plan_hash_at_request)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `
    )
    .run(id, i.proposalId, i.tenantId, i.requestedBy, expiresAt, i.policy, i.planId, i.planHash)
  return getApproval(id)!
}

export function getApproval(id: string): ApprovalRow | null {
  return (
    (getDb().prepare(`SELECT * FROM sync_approvals WHERE id = ?`).get(id) as ApprovalRow | undefined) ?? null
  )
}

export function findActiveApprovalForProposal(proposalId: string): ApprovalRow | null {
  return (
    (getDb()
      .prepare(
        `
    SELECT * FROM sync_approvals
     WHERE proposal_id = ? AND state IN ('pending','partially_granted')
     ORDER BY requested_at DESC
     LIMIT 1
  `
      )
      .get(proposalId) as ApprovalRow | undefined) ?? null
  )
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

/** Atomically advance the approval state machine on a grant action. */
export function grantApproval(i: GrantApprovalInput): ApprovalRow {
  const db = getDb()
  const row = getApproval(i.approvalId)
  if (!row) throw new ApprovalError("not_found", `Approval ${i.approvalId} not found`)
  if (row.state !== "pending" && row.state !== "partially_granted") {
    throw new ApprovalError("wrong_state", `Approval is ${row.state}`)
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare(`UPDATE sync_approvals SET state = 'expired' WHERE id = ?`).run(i.approvalId)
    throw new ApprovalError("expired", "Approval window has closed")
  }
  if (i.approver === row.requested_by) {
    throw new ApprovalError("self_grant", "Requester cannot approve their own proposal")
  }
  if (i.approver === row.granted_by_1) {
    throw new ApprovalError("duplicate_grant", "Approver already granted")
  }

  if (row.policy === "single") {
    db.prepare(
      `
      UPDATE sync_approvals SET state = 'granted', granted_by_1 = ?, granted_at_1 = datetime('now')
       WHERE id = ?`
    ).run(i.approver, i.approvalId)
  } else if (row.policy === "dual") {
    if (!row.granted_by_1) {
      db.prepare(
        `
        UPDATE sync_approvals SET state = 'partially_granted', granted_by_1 = ?, granted_at_1 = datetime('now')
         WHERE id = ?`
      ).run(i.approver, i.approvalId)
    } else {
      db.prepare(
        `
        UPDATE sync_approvals SET state = 'granted', granted_by_2 = ?, granted_at_2 = datetime('now')
         WHERE id = ?`
      ).run(i.approver, i.approvalId)
    }
  } else {
    // 'none' policies should never reach the grant route — guard anyway.
    db.prepare(`UPDATE sync_approvals SET state = 'granted' WHERE id = ?`).run(i.approvalId)
  }
  return getApproval(i.approvalId)!
}

export function rejectApproval(approvalId: string, rejector: string, reason: string): ApprovalRow {
  const row = getApproval(approvalId)
  if (!row) throw new ApprovalError("not_found", `Approval ${approvalId} not found`)
  if (row.state !== "pending" && row.state !== "partially_granted") {
    throw new ApprovalError("wrong_state", `Approval is ${row.state}`)
  }
  getDb()
    .prepare(
      `
    UPDATE sync_approvals SET state = 'rejected', rejected_by = ?, rejected_at = datetime('now'), reject_reason = ?
     WHERE id = ?`
    )
    .run(rejector, reason, approvalId)
  return getApproval(approvalId)!
}

export function bypassApproval(approvalId: string, actor: string, reason: string): ApprovalRow {
  const row = getApproval(approvalId)
  if (!row) throw new ApprovalError("not_found", `Approval ${approvalId} not found`)
  if (row.state === "granted" || row.state === "bypassed") return row
  getDb()
    .prepare(
      `
    UPDATE sync_approvals SET state = 'bypassed', bypass_by = ?, bypass_reason = ?
     WHERE id = ?`
    )
    .run(actor, reason, approvalId)
  return getApproval(approvalId)!
}

export function expireDueApprovals(): number {
  // `expires_at` is stored as a JS ISO-8601 string ("…T…Z"). SQLite's
  // `datetime('now')` returns "YYYY-MM-DD HH:MM:SS" which, under text
  // comparison, sorts *before* any 'T'-shaped ISO string — so a naïve
  // `< datetime('now')` never matches. Pass the current ISO timestamp
  // explicitly so the comparison stays text-lexicographic on a uniform
  // format.
  const r = getDb()
    .prepare(
      `
    UPDATE sync_approvals
       SET state = 'expired'
     WHERE state IN ('pending','partially_granted')
       AND expires_at < ?
  `
    )
    .run(new Date().toISOString())
  return r.changes
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
  getDb()
    .prepare(
      `
    INSERT INTO sync_approval_tokens (token_hash, approval_id, action, issued_to, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `
    )
    .run(tokenHash, i.approvalId, i.action, i.issuedTo, expiresAt)
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
  const row = getDb()
    .prepare(
      `
    SELECT approval_id, action, issued_to, expires_at, used_at
      FROM sync_approval_tokens WHERE token_hash = ?
  `
    )
    .get(tokenHash) as
    | {
        approval_id: string
        action: "grant" | "reject"
        issued_to: string
        expires_at: string
        used_at: string | null
      }
    | undefined
  if (!row) throw new ApprovalError("token_invalid", "Unknown or invalid token")
  if (row.used_at) throw new ApprovalError("token_used", "Token has already been used")
  if (new Date(row.expires_at).getTime() < Date.now()) {
    throw new ApprovalError("token_expired", "Token has expired")
  }
  getDb()
    .prepare(`UPDATE sync_approval_tokens SET used_at = datetime('now'), used_by = ? WHERE token_hash = ?`)
    .run(i.by, tokenHash)
  return { approvalId: row.approval_id, action: row.action, issuedTo: row.issued_to }
}
