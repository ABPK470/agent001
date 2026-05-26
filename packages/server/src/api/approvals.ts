/**
 * Approval workflow transport routes.
 */

import type { RiskTier } from "@mia/agent"
import { EventType } from "@mia/shared-enums"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import * as db from "../adapters/persistence/sqlite.js"
import { broadcast } from "../event-broadcaster.js"

const DEFAULT_TENANT_ID = "_default"
const TOKEN_TTL_MS_DEFAULT = 24 * 60 * 60 * 1000
const APPROVAL_TTL_MS_DEFAULT = 24 * 60 * 60 * 1000
const POLICY_DEFAULT_TARGET_ENV = "*"

function resolveTenant(req: FastifyRequest): string {
	const q = (req.query as Record<string, string> | undefined)?.["tenant"]
	if (q && req.session?.isAdmin) return q
	return DEFAULT_TENANT_ID
}

function requireTokenSecret(): string {
	const secret = process.env["APPROVAL_TOKEN_SECRET"]
	if (!secret || secret.length < 32) throw new Error("APPROVAL_TOKEN_SECRET must be set and ≥ 32 chars")
	return secret
}

export function registerApprovalRoutes(app: FastifyInstance): void {
	app.get<{ Querystring: { tenant?: string; state?: string; proposalId?: string } }>("/api/approvals", async (req) => {
		const tenantId = resolveTenant(req)
		const where: string[] = ["tenant_id = ?"]
		const args: unknown[] = [tenantId]
		if (req.query.state) { where.push("state = ?"); args.push(req.query.state) }
		if (req.query.proposalId) { where.push("proposal_id = ?"); args.push(req.query.proposalId) }
		const sql = `SELECT * FROM sync_approvals WHERE ${where.join(" AND ")} ORDER BY requested_at DESC LIMIT 500`
		return db.getDb().prepare(sql).all(...args)
	})

	app.get<{ Params: { id: string } }>("/api/approvals/:id", async (req, reply) => {
		const approval = db.getApproval(req.params.id)
		if (!approval) { reply.code(404); return { error: "not found" } }
		return approval
	})

	app.post<{ Body: { proposalId: string; planId?: string; planHash?: string; ttlMs?: number } }>("/api/approvals", async (req, reply) => {
		const proposal = db.getProposal(req.body.proposalId)
		if (!proposal) { reply.code(404); return { error: "proposal not found" } }
		const tier: RiskTier = (proposal.risk_tier ?? "low") as RiskTier
		const policy = db.getApprovalPolicy(proposal.tenant_id, proposal.target ?? POLICY_DEFAULT_TARGET_ENV, tier)
		if (policy.policy === "none") {
			reply.code(400)
			return { error: "approval not required for this risk tier" }
		}
		const ttl = req.body.ttlMs ?? APPROVAL_TTL_MS_DEFAULT
		const approval = db.createApproval({
			proposalId: req.body.proposalId,
			tenantId: proposal.tenant_id,
			requestedBy: req.session.upn,
			policy: policy.policy,
			ttlMs: ttl,
			planId: req.body.planId ?? null,
			planHash: req.body.planHash ?? null,
		})
		db.updateProposalStatus({
			id: req.body.proposalId,
			to: "awaiting_approval",
			actor: req.session.upn,
			reason: `approval ${approval.id} requested`,
		})
		broadcast({ type: EventType.SyncApprovalRequested, data: { approvalId: approval.id, proposalId: req.body.proposalId, policy: policy.policy } })
		reply.code(201)
		return approval
	})

	app.post<{ Params: { id: string }; Body: { planHashAtGrant?: string } }>("/api/approvals/:id/grant", async (req, reply) => {
		try {
			const approval = db.grantApproval({ approvalId: req.params.id, approver: req.session.upn, planHashAtGrant: req.body.planHashAtGrant ?? null })
			broadcast({ type: EventType.SyncApprovalGranted, data: { approvalId: approval.id, proposalId: approval.proposal_id, state: approval.state, by: req.session.upn } })
			return approval
		} catch (error) {
			return mapApprovalError(reply, error)
		}
	})

	app.post<{ Params: { id: string }; Body: { reason: string } }>("/api/approvals/:id/reject", async (req, reply) => {
		if (!req.body.reason?.trim()) { reply.code(400); return { error: "reason is required" } }
		try {
			const approval = db.rejectApproval(req.params.id, req.session.upn, req.body.reason)
			broadcast({ type: EventType.SyncApprovalRejected, data: { approvalId: approval.id, proposalId: approval.proposal_id, by: req.session.upn, reason: req.body.reason } })
			return approval
		} catch (error) {
			return mapApprovalError(reply, error)
		}
	})

	app.post<{ Params: { id: string }; Body: { reason: string } }>("/api/approvals/:id/bypass", async (req, reply) => {
		if (!req.session?.isAdmin) { reply.code(403); return { error: "admin only" } }
		if (!req.body.reason?.trim()) { reply.code(400); return { error: "reason is required" } }
		try {
			const approval = db.bypassApproval(req.params.id, req.session.upn, req.body.reason)
			broadcast({ type: EventType.SyncApprovalBypassed, data: { approvalId: approval.id, proposalId: approval.proposal_id, by: req.session.upn, reason: req.body.reason } })
			return approval
		} catch (error) {
			return mapApprovalError(reply, error)
		}
	})

	app.post<{ Params: { id: string }; Body: { action: "grant" | "reject"; issuedTo: string; ttlMs?: number } }>("/api/approvals/:id/tokens", async (req, reply) => {
		if (!req.session?.isAdmin) { reply.code(403); return { error: "admin only" } }
		const secret = requireTokenSecret()
		const token = db.issueApprovalToken({ approvalId: req.params.id, action: req.body.action, issuedTo: req.body.issuedTo, ttlMs: req.body.ttlMs ?? TOKEN_TTL_MS_DEFAULT, secret })
		reply.code(201)
		return token
	})

	app.get<{ Params: { raw: string }; Querystring: { reason?: string } }>("/api/approvals/tokens/:raw", async (req, reply) => {
		const secret = requireTokenSecret()
		try {
			const token = db.consumeApprovalToken({ raw: req.params.raw, secret, by: req.session.upn })
			if (token.action === "grant") {
				const approval = db.grantApproval({ approvalId: token.approvalId, approver: req.session.upn, planHashAtGrant: null })
				broadcast({ type: EventType.SyncApprovalGranted, data: { approvalId: approval.id, proposalId: approval.proposal_id, state: approval.state, by: req.session.upn, viaToken: true } })
				return approval
			}
			const reason = req.query.reason ?? "rejected via one-click token"
			const approval = db.rejectApproval(token.approvalId, req.session.upn, reason)
			broadcast({ type: EventType.SyncApprovalRejected, data: { approvalId: approval.id, proposalId: approval.proposal_id, by: req.session.upn, viaToken: true } })
			return approval
		} catch (error) {
			return mapApprovalError(reply, error)
		}
	})

	app.get<{ Querystring: { tenant?: string } }>("/api/approvals/policies", async (req) => db.listApprovalPolicies(resolveTenant(req)))

	app.put<{ Body: { targetEnv: string; riskTier: RiskTier; policy: db.ApprovalPolicyKind; approvers?: readonly string[]; bypassRole?: string | null } }>("/api/approvals/policies", async (req, reply) => {
		if (!req.session?.isAdmin) { reply.code(403); return { error: "admin only" } }
		try {
			db.upsertApprovalPolicy({
				tenantId: resolveTenant(req),
				targetEnv: req.body.targetEnv,
				riskTier: req.body.riskTier,
				policy: req.body.policy,
				approvers: req.body.approvers ?? [],
				bypassRole: req.body.bypassRole ?? "admin",
			}, req.session.upn)
			return { ok: true }
		} catch (error) {
			reply.code(400)
			return { error: error instanceof Error ? error.message : String(error) }
		}
	})
}

function mapApprovalError(reply: FastifyReply, error: unknown): { error: string; code?: string } {
	if (error instanceof db.ApprovalError) {
		reply.code(error.code === "not_found" ? 404 : 400)
		return { error: error.message, code: error.code }
	}
	reply.code(500)
	return { error: error instanceof Error ? error.message : String(error) }
}
