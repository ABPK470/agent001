/**
 * Entity registry transport routes.
 */

import { EventType } from "@mia/shared-enums"
import type { EntityRegistryYamlImportResponse } from "@mia/shared-types"
import { BUNDLED_SCD2_STRATEGIES, type EntityDefinition, type Scd2Strategy } from "@mia/sync"
import type { FastifyInstance, FastifyRequest } from "fastify"
import * as db from "../adapters/persistence/sqlite.js"
import { bootstrapEntityRegistryFromYaml } from "../adapters/sync/entity-bootstrap.js"
import { formatEntitiesYaml, formatEntityYaml, parseEntitiesYaml } from "../adapters/sync/entity-yaml.js"
import { broadcast } from "../event-broadcaster.js"

const DEFAULT_TENANT_ID = "_default"

function resolveTenant(req: FastifyRequest): string {
	const q = (req.query as Record<string, string> | undefined)?.["tenant"]
	if (q && req.session?.isAdmin) return q
	return DEFAULT_TENANT_ID
}

function audit(req: FastifyRequest, action: string, detail: Record<string, unknown>): void {
	try {
		db.saveAdminAudit({ actor: req.session.upn, action, detail: JSON.stringify(detail), timestamp: new Date().toISOString(), scope_id: "entity-registry" })
	} catch (error) {
		console.warn("[entity-registry] audit_log write failed:", error instanceof Error ? error.message : error)
	}
}

export function registerEntityRegistryRoutes(app: FastifyInstance, projectRoot?: string): void {
	app.get("/api/entity-registry/entities", async (req) => {
		const tenantId = resolveTenant(req)
		const includeRetired = ((req.query as Record<string, string> | undefined)?.["includeRetired"] ?? "false") === "true"
		return { tenantId, items: db.listEntityDefinitions(tenantId, { includeRetired }) }
	})

	app.get<{ Params: { id: string }; Querystring: { version?: string; includeRetired?: string } }>("/api/entity-registry/entities/:id", async (req, reply) => {
		const tenantId = resolveTenant(req)
		const version = req.query.version ? Number(req.query.version) : undefined
		const includeRetired = req.query.includeRetired === "true"
		const def = db.getEntityDefinition(tenantId, req.params.id, { version, includeRetired })
		if (!def) { reply.code(404); return { error: `entity not found: ${req.params.id}` } }
		return def
	})

	app.get<{ Params: { id: string } }>("/api/entity-registry/entities/:id.yaml", async (req, reply) => {
		const tenantId = resolveTenant(req)
		const def = db.getEntityDefinition(tenantId, req.params.id, { includeRetired: true })
		if (!def) { reply.code(404); return { error: `entity not found: ${req.params.id}` } }
		reply.header("content-type", "application/yaml; charset=utf-8")
		return formatEntityYaml(def)
	})

	app.get("/api/entity-registry/entities.yaml", async (req, reply) => {
		const tenantId = resolveTenant(req)
		const defs = db.listEntityDefinitions(tenantId, { includeRetired: true })
		reply.header("content-type", "application/yaml; charset=utf-8")
		return formatEntitiesYaml(defs)
	})

	app.get<{ Params: { id: string } }>("/api/entity-registry/entities/:id/history", async (req) => db.listEntityDefinitionHistory(resolveTenant(req), req.params.id))

	app.post<{ Body: { def: EntityDefinition; reason: string; versionLabel?: string | null } }>("/api/entity-registry/entities", async (req, reply) => {
		if (!req.session?.isAdmin) { reply.code(403); return { error: "admin only" } }
		if (!req.body?.def) { reply.code(400); return { error: "missing 'def' in body" } }
		if (!req.body.reason || req.body.reason.trim() === "") { reply.code(400); return { error: "'reason' is required" } }
		const tenantId = resolveTenant(req)
		try {
			const result = db.saveEntityDefinition({ tenantId, def: req.body.def, actor: req.session.upn, reason: req.body.reason, versionLabel: req.body.versionLabel ?? null })
			audit(req, "entity_registry.saved", { tenantId, id: result.id, version: result.version, reason: req.body.reason })
			broadcast({ type: EventType.EntityRegistrySaved, data: { tenantId, id: result.id, version: result.version, actor: req.session.upn, diffSize: result.diff.length } })
			return result
		} catch (error) {
			if (error instanceof db.EntityRegistryValidationError) {
				reply.code(422)
				return { error: "validation_failed", result: error.result }
			}
			reply.code(500)
			return { error: (error as Error).message }
		}
	})

	app.delete<{ Params: { id: string } }>("/api/entity-registry/entities/:id", async (req, reply) => {
		if (!req.session?.isAdmin) { reply.code(403); return { error: "admin only" } }
		const tenantId = resolveTenant(req)
		const result = db.retireEntityDefinition(tenantId, req.params.id, req.session.upn)
		if (!result) { reply.code(404); return { error: `entity not found: ${req.params.id}` } }
		audit(req, "entity_registry.retired", { tenantId, id: req.params.id })
		broadcast({ type: EventType.EntityRegistryRetired, data: { tenantId, id: req.params.id, actor: req.session.upn, retiredAt: result.retiredAt } })
		return result
	})

	app.post<{ Body: { yaml: string; reason: string; dryRun?: boolean } }>("/api/entity-registry/entities/import-yaml", async (req, reply): Promise<EntityRegistryYamlImportResponse | { error: string }> => {
		if (!req.session?.isAdmin) { reply.code(403); return { error: "admin only" } }
		if (typeof req.body?.yaml !== "string" || req.body.yaml.trim() === "") { reply.code(400); return { error: "'yaml' body is required" } }
		if (!req.body.reason || req.body.reason.trim() === "") { reply.code(400); return { error: "'reason' is required" } }
		const tenantId = resolveTenant(req)
		const dryRun = Boolean(req.body.dryRun)
		const parsed = parseEntitiesYaml(req.body.yaml)
		const saved: EntityRegistryYamlImportResponse["saved"] = []
		const skipped: EntityRegistryYamlImportResponse["skipped"] = []
		const errors: EntityRegistryYamlImportResponse["errors"] = []

		for (const item of parsed) {
			if (!item.ok || !item.def) {
				errors.push({ id: null, error: item.error ?? "unknown parse error" })
				continue
			}
			const existing = db.getEntityDefinition(tenantId, item.def.id, { includeRetired: true })
			const created = existing === null
			if (dryRun) {
				saved.push({ id: item.def.id, version: existing ? existing.version + 1 : 1, created })
				continue
			}
			try {
				const result = db.saveEntityDefinition({ tenantId, def: { ...item.def, tenantId }, actor: req.session.upn, reason: req.body.reason })
				saved.push({ id: result.id, version: result.version, created })
				broadcast({ type: EventType.EntityRegistryImported, data: { tenantId, id: result.id, version: result.version, created, actor: req.session.upn } })
			} catch (error) {
				if (error instanceof db.EntityRegistryValidationError) {
					errors.push({ id: item.def.id, error: error.result })
				} else {
					errors.push({ id: item.def.id, error: (error as Error).message })
				}
			}
		}

		if (!dryRun) {
			audit(req, "entity_registry.imported", { tenantId, savedCount: saved.length, errorCount: errors.length })
		}

		return { ok: errors.length === 0, saved, skipped, errors, dryRun }
	})

	app.post("/api/entity-registry/reseed", async (req, reply) => {
		if (!req.session?.isAdmin) { reply.code(403); return { error: "admin only" } }
		if (!projectRoot) { reply.code(500); return { error: "projectRoot not configured" } }
		try {
			const result = bootstrapEntityRegistryFromYaml(projectRoot)
			audit(req, "entity_registry.reseeded", { imported: result.imported, skipped: result.skipped, errors: result.errors.length })
			if (result.imported > 0) {
				broadcast({ type: EventType.EntityRegistryImported, data: { tenantId: DEFAULT_TENANT_ID, actor: req.session.upn, imported: result.imported, source: "reseed" } })
			}
			return result
		} catch (error) {
			reply.code(500)
			return { error: (error as Error).message }
		}
	})

	app.get("/api/entity-registry/strategies", async (req) => {
		const tenantId = resolveTenant(req)
		const stored = db.listAvailableStrategies(tenantId)
		const seen = new Set(stored.map((strategy) => strategy.id))
		const bundled = BUNDLED_SCD2_STRATEGIES.filter((strategy) => !seen.has(strategy.id))
		return { tenantId, items: [...stored, ...bundled] }
	})

	app.post<{ Body: { strategy: Scd2Strategy; reason: string } }>("/api/entity-registry/strategies", async (req, reply) => {
		if (!req.session?.isAdmin) { reply.code(403); return { error: "admin only" } }
		if (!req.body?.strategy) { reply.code(400); return { error: "missing 'strategy' in body" } }
		if (!req.body.reason || req.body.reason.trim() === "") { reply.code(400); return { error: "'reason' is required" } }
		const tenantId = resolveTenant(req)
		try {
			const result = db.saveScd2Strategy({ tenantId, strategy: req.body.strategy, actor: req.session.upn, reason: req.body.reason })
			audit(req, "entity_registry.strategy_saved", { tenantId, id: result.id, version: result.version })
			broadcast({ type: EventType.EntityRegistryStrategySaved, data: { tenantId, id: result.id, version: result.version, actor: req.session.upn } })
			return result
		} catch (error) {
			if (error instanceof db.EntityRegistryValidationError) {
				reply.code(422)
				return { error: "validation_failed", result: error.result }
			}
			reply.code(500)
			return { error: (error as Error).message }
		}
	})
}
