/**
 * Evidence transport routes.
 */

import type { FastifyInstance, FastifyRequest } from "fastify"
import { createReadStream, existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import type { Signer } from "../adapters/persistence/evidence.js"
import { getEvidenceByPlan, listEvidence, verifyEvidence, type EvidenceIndexRow } from "../adapters/persistence/evidence.js"
import { getDb } from "../adapters/persistence/sqlite.js"

const DEFAULT_TENANT_ID = "_default"

function resolveTenant(req: FastifyRequest): string {
	const q = (req.query as Record<string, string> | undefined)?.["tenant"]
	if (q && req.session?.isAdmin) return q
	return DEFAULT_TENANT_ID
}

export interface EvidenceRoutesDeps {
	storageRoot: string
	signer: Signer | null
}

export function registerEvidenceRoutes(app: FastifyInstance, deps: EvidenceRoutesDeps): void {
	app.get<{ Querystring: { tenant?: string; limit?: string } }>("/api/evidence", async (req) => {
		const tenantId = resolveTenant(req)
		const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100))
		return listEvidence(tenantId, limit)
	})

	app.get<{ Params: { planId: string } }>("/api/evidence/by-plan/:planId", async (req, reply) => {
		const row = getEvidenceByPlan(req.params.planId)
		if (!row) { reply.code(404); return { error: "no evidence for plan" } }
		return row
	})

	app.get<{ Params: { id: string } }>("/api/evidence/:id/envelope.json", async (req, reply) => {
		const row = lookupEvidenceById(req.params.id)
		if (!row) { reply.code(404); return reply.send({ error: "evidence not found" }) }
		const abs = resolve(deps.storageRoot, row.envelope_path)
		if (!existsSync(abs)) { reply.code(410); return reply.send({ error: "envelope file missing on disk" }) }
		reply.header("content-type", "application/json")
		reply.header("content-disposition", `attachment; filename="${row.plan_id}.envelope.json"`)
		return reply.send(createReadStream(abs))
	})

	app.get<{ Params: { id: string } }>("/api/evidence/:id/evidence.pdf", async (req, reply) => {
		const row = lookupEvidenceById(req.params.id)
		if (!row || !row.pdf_path) { reply.code(404); return reply.send({ error: "evidence pdf not found" }) }
		const abs = resolve(deps.storageRoot, row.pdf_path)
		if (!existsSync(abs)) { reply.code(410); return reply.send({ error: "pdf file missing on disk" }) }
		reply.header("content-type", "application/pdf")
		reply.header("content-disposition", `attachment; filename="${row.plan_id}.evidence.pdf"`)
		return reply.send(createReadStream(abs))
	})

	app.post<{ Params: { id: string } }>("/api/evidence/:id/verify", async (req, reply) => {
		if (!deps.signer) { reply.code(501); return { error: "evidence signer not configured" } }
		const row = lookupEvidenceById(req.params.id)
		if (!row) { reply.code(404); return { error: "evidence not found" } }
		const abs = resolve(deps.storageRoot, row.envelope_path)
		if (!existsSync(abs)) { reply.code(410); return { error: "envelope file missing on disk" } }
		const envelopeJson = await readFile(abs, "utf-8")
		return verifyEvidence({ envelopeJson, signer: deps.signer })
	})
}

function lookupEvidenceById(id: string): EvidenceIndexRow | null {
	return (getDb().prepare(`SELECT * FROM sync_evidence WHERE id = ?`).get(id) as EvidenceIndexRow | undefined) ?? null
}
