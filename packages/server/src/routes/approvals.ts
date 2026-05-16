/**
 * F1.7 — Approval workflow routes.
 *
 *   GET    /api/approvals                       list approvals (filter by state, proposal)
 *   GET    /api/approvals/:id                   single approval
 *   POST   /api/approvals                       create approval for a proposal (kicks off TTL)
 *   POST   /api/approvals/:id/grant             grant (caller must not be requester / prior grantor)
 *   POST   /api/approvals/:id/reject            reject with reason
 *   POST   /api/approvals/:id/bypass            admin-only with reason
 *   POST   /api/approvals/:id/tokens            issue one-click HMAC-bound token (admin only)
 *   GET    /api/approvals/tokens/:raw           consume token + perform grant/reject
 *   GET    /api/approvals/policies              list policies for tenant
 *   PUT    /api/approvals/policies              upsert policy (admin only)
 *
 * Token secret comes from APPROVAL_TOKEN_SECRET (required for the token
 * endpoints). All grants broadcast `sync.approval.granted` SSE so the UI
 * updates without polling.
 */

import type { RiskTier } from "@mia/agent"
import { EventType } from "@mia/shared-enums"
import type { FastifyInstance, FastifyRequest } from "fastify"
import * as db from "../db/index.js"
import { broadcast } from "../event-broadcaster.js"

const DEFAULT_TENANT_ID = "_default"
const TOKEN_TTL_MS_DEFAULT = 24 * 60 * 60 * 1000
// Default approval window when neither caller nor policy specify one.
const APPROVAL_TTL_MS_DEFAULT = 24 * 60 * 60 * 1000
// Per-tier defaults for the legacy single-arg lookup. Routes that do
// not carry a target-env (e.g. /api/approvals) fall back to this sentinel
// so the policy lookup remains deterministic.
const POLICY_DEFAULT_TARGET_ENV = "*"

function resolveTenant(req: FastifyRequest): string {
  const q = (req.query as Record<string, string> | undefined)?.["tenant"]
  if (q && req.session?.isAdmin) return q
  return DEFAULT_TENANT_ID
}

function requireTokenSecret(): string {
  const s = process.env["APPROVAL_TOKEN_SECRET"]
  if (!s || s.length < 32) throw new Error("APPROVAL_TOKEN_SECRET must be set and ≥ 32 chars")
  return s
}

export function registerApprovalRoutes(app: FastifyInstance): void {

  app.get<{ Querystring: { tenant?: string; state?: string; proposalId?: string } }>(
    "/api/approvals",
    async (req) => {
      const tenantId = resolveTenant(req)
      const where: string[] = ["tenant_id = ?"]
      const args:  unknown[] = [tenantId]
      if (req.query.state)      { where.push("state = ?");       args.push(req.query.state) }
      if (req.query.proposalId) { where.push("proposal_id = ?"); args.push(req.query.proposalId) }
      const sql = `SELECT * FROM sync_approvals WHERE ${where.join(" AND ")} ORDER BY requested_at DESC LIMIT 500`
      return db.getDb().prepare(sql).all(...args)
    },
  )

  app.get<{ Params: { id: string } }>("/api/approvals/:id", async (req, reply) => {
    const a = db.getApproval(req.params.id)
    if (!a) { reply.code(404); return { error: "not found" } }
    return a
  })

  app.post<{ Body: { proposalId: string; planId?: string; planHash?: string; ttlMs?: number } }>(
    "/api/approvals",
    async (req, reply) => {
      const proposal = db.getProposal(req.body.proposalId)
      if (!proposal) { reply.code(404); return { error: "proposal not found" } }
      const tier: RiskTier = (proposal.risk_tier ?? "low") as RiskTier
      const policy = db.getApprovalPolicy(proposal.tenant_id, proposal.target ?? POLICY_DEFAULT_TARGET_ENV, tier)
      if (policy.policy === "none") {
        reply.code(400); return { error: "approval not required for this risk tier" }
      }
      const ttl = req.body.ttlMs ?? APPROVAL_TTL_MS_DEFAULT
      const approval = db.createApproval({
        proposalId:  req.body.proposalId,
        tenantId:    proposal.tenant_id,
        requestedBy: req.session.upn,
        policy:      policy.policy,
        ttlMs:       ttl,
        planId:      req.body.planId ?? null,
        planHash:    req.body.planHash ?? null,
      })
      db.updateProposalStatus({
        id: req.body.proposalId, to: "awaiting_approval", actor: req.session.upn,
        reason: `approval ${approval.id} requested`,
      })
      broadcast({ type: EventType.SyncApprovalRequested, data: { approvalId: approval.id, proposalId: req.body.proposalId, policy: policy.policy } })
      reply.code(201)
      return approval
    },
  )

  app.post<{ Params: { id: string }; Body: { planHashAtGrant?: string } }>(
    "/api/approvals/:id/grant",
    async (req, reply) => {
      try {
        const a = db.grantApproval({
          approvalId: req.params.id, approver: req.session.upn,
          planHashAtGrant: req.body.planHashAtGrant ?? null,
        })
        broadcast({ type: EventType.SyncApprovalGranted, data: { approvalId: a.id, proposalId: a.proposal_id, state: a.state, by: req.session.upn } })
        return a
      } catch (e) { return mapApprovalError(reply, e) }
    },
  )

  app.post<{ Params: { id: string }; Body: { reason: string } }>(
    "/api/approvals/:id/reject",
    async (req, reply) => {
      if (!req.body.reason?.trim()) { reply.code(400); return { error: "reason is required" } }
      try {
        const a = db.rejectApproval(req.params.id, req.session.upn, req.body.reason)
        broadcast({ type: EventType.SyncApprovalRejected, data: { approvalId: a.id, proposalId: a.proposal_id, by: req.session.upn, reason: req.body.reason } })
        return a
      } catch (e) { return mapApprovalError(reply, e) }
    },
  )

  app.post<{ Params: { id: string }; Body: { reason: string } }>(
    "/api/approvals/:id/bypass",
    async (req, reply) => {
      if (!req.session?.isAdmin) { reply.code(403); return { error: "admin only" } }
      if (!req.body.reason?.trim()) { reply.code(400); return { error: "reason is required" } }
      try {
        const a = db.bypassApproval(req.params.id, req.session.upn, req.body.reason)
        broadcast({ type: EventType.SyncApprovalBypassed, data: { approvalId: a.id, proposalId: a.proposal_id, by: req.session.upn, reason: req.body.reason } })
        return a
      } catch (e) { return mapApprovalError(reply, e) }
    },
  )

  // ── one-click tokens ────────────────────────────────────────
  app.post<{ Params: { id: string }; Body: { action: "grant" | "reject"; issuedTo: string; ttlMs?: number } }>(
    "/api/approvals/:id/tokens",
    async (req, reply) => {
      if (!req.session?.isAdmin) { reply.code(403); return { error: "admin only" } }
      const secret = requireTokenSecret()
      const t = db.issueApprovalToken({
        approvalId: req.params.id,
        action:     req.body.action,
        issuedTo:   req.body.issuedTo,
        ttlMs:      req.body.ttlMs ?? TOKEN_TTL_MS_DEFAULT,
        secret,
      })
      reply.code(201)
      return t
    },
  )

  app.get<{ Params: { raw: string }; Querystring: { reason?: string } }>(
    "/api/approvals/tokens/:raw",
    async (req, reply) => {
      const secret = requireTokenSecret()
      try {
        const t = db.consumeApprovalToken({ raw: req.params.raw, secret, by: req.session.upn })
        if (t.action === "grant") {
          const a = db.grantApproval({ approvalId: t.approvalId, approver: req.session.upn, planHashAtGrant: null })
          broadcast({ type: EventType.SyncApprovalGranted, data: { approvalId: a.id, proposalId: a.proposal_id, state: a.state, by: req.session.upn, viaToken: true } })
          return a
        }
        const reason = req.query.reason ?? "rejected via one-click token"
        const a = db.rejectApproval(t.approvalId, req.session.upn, reason)
        broadcast({ type: EventType.SyncApprovalRejected, data: { approvalId: a.id, proposalId: a.proposal_id, by: req.session.upn, viaToken: true } })
        return a
      } catch (e) { return mapApprovalError(reply, e) }
    },
  )

  // ── policies ────────────────────────────────────────────────
  app.get<{ Querystring: { tenant?: string } }>(
    "/api/approvals/policies",
    async (req) => db.listApprovalPolicies(resolveTenant(req)),
  )

  app.put<{ Body: {
    targetEnv: string; riskTier: RiskTier; policy: db.ApprovalPolicyKind;
    approvers?: readonly string[]; bypassRole?: string | null;
  } }>("/api/approvals/policies", async (req, reply) => {
    if (!req.session?.isAdmin) { reply.code(403); return { error: "admin only" } }
    try {
      db.upsertApprovalPolicy(
        {
          tenantId:   resolveTenant(req),
          targetEnv:  req.body.targetEnv,
          riskTier:   req.body.riskTier,
          policy:     req.body.policy,
          approvers:  req.body.approvers ?? [],
          bypassRole: req.body.bypassRole ?? "admin",
        },
        req.session.upn,
      )
      return { ok: true }
    } catch (e) {
      reply.code(400)
      return { error: e instanceof Error ? e.message : String(e) }
    }
  })
}

function mapApprovalError(reply: import("fastify").FastifyReply, e: unknown): { error: string; code?: string } {
  if (e instanceof db.ApprovalError) {
    reply.code(e.code === "not_found" ? 404 : 400)
    return { error: e.message, code: e.code }
  }
  reply.code(500)
  return { error: e instanceof Error ? e.message : String(e) }
}
