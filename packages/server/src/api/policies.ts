/**
 * Policy transport routes.
 */

import { isPolicyEffect, PolicyEffect } from "@mia/agent"
import type { FastifyInstance, FastifyRequest } from "fastify"
import * as db from "../adapters/persistence/sqlite.js"

function audit(req: FastifyRequest, action: string, detail: Record<string, unknown>): void {
	try {
		db.saveAdminAudit({
			actor: req.session.upn,
			action,
			detail: JSON.stringify(detail),
			timestamp: new Date().toISOString(),
			scope_id: "policies",
		})
	} catch (error) {
		console.warn("[policies] audit_log write failed:", error instanceof Error ? error.message : error)
	}
}

export function registerPolicyRoutes(app: FastifyInstance): void {
	app.get("/api/policies", async (req, reply) => {
		if (!req.session?.isAdmin) { reply.code(403); return { error: "admin only" } }
		return db.listPolicyRules().map((rule) => ({
			name: rule.name,
			effect: rule.effect,
			condition: rule.condition,
			parameters: JSON.parse(rule.parameters),
			source: rule.source ?? db.PolicySource.Db,
			createdAt: rule.created_at,
			updatedAt: rule.updated_at ?? null,
			updatedBy: rule.updated_by ?? null,
		}))
	})

	app.post<{ Body: { name: string; effect: string; condition: string; parameters?: Record<string, unknown> } }>("/api/policies", async (req, reply) => {
		if (!req.session?.isAdmin) { reply.code(403); return { error: "admin only" } }
		const { name, effect, condition, parameters } = req.body
		if (!name || !effect || !condition) {
			reply.code(400)
			return { error: "name, effect, and condition are required" }
		}
		if (!isPolicyEffect(effect)) {
			reply.code(400)
			return { error: "effect must be allow, require_approval, or deny" }
		}

		const existing = db.listPolicyRules().find((rule) => rule.name === name)
		const now = new Date().toISOString()
		db.savePolicyRule({
			name,
			effect: effect satisfies PolicyEffect,
			condition,
			parameters: JSON.stringify(parameters ?? {}),
			created_at: existing?.created_at ?? now,
			source: existing?.source ?? db.PolicySource.Db,
			updated_at: now,
			updated_by: req.session.upn,
		})

		audit(req, existing ? "policy.update" : "policy.create", { name, effect, condition })
		reply.code(existing ? 200 : 201)
		return { ok: true }
	})

	app.delete<{ Params: { name: string } }>("/api/policies/:name", async (req, reply) => {
		if (!req.session?.isAdmin) { reply.code(403); return { error: "admin only" } }
		const before = db.listPolicyRules().find((rule) => rule.name === req.params.name)
		db.deletePolicyRule(req.params.name)
		audit(req, "policy.delete", { name: req.params.name, source: before?.source ?? null })
		return { ok: true }
	})
}
