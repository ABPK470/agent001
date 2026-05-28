/**
 * Entity registry transport routes.
 */

import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

import { EventType } from "@mia/shared-enums"
import type {
    EntityRegistryDocumentImportRequest,
    EntityRegistrySyncDefinitionScaffoldResponse,
    EntityRegistryYamlImportResponse,
} from "@mia/shared-types"
import { BUNDLED_SCD2_STRATEGIES, type EntityDefinition, type Scd2Strategy } from "@mia/sync"
import type { FastifyInstance, FastifyRequest } from "fastify"
import * as db from "../adapters/persistence/sqlite.js"
import { formatEntitiesYaml, formatEntityYaml, parseEntitiesJson, parseEntitiesYaml } from "../adapters/sync/entity-yaml.js"
import { broadcast } from "../event-broadcaster.js"

const DEFAULT_TENANT_ID = "_default"
const execFileAsync = promisify(execFile)

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

function importEntitiesFromText(args: {
	tenantId: string
	actor: string
	reason: string
	content: string
	format: "yaml" | "json"
	dryRun: boolean
}): EntityRegistryYamlImportResponse {
	const parsed = args.format === "json" ? parseEntitiesJson(args.content) : parseEntitiesYaml(args.content)
	const saved: EntityRegistryYamlImportResponse["saved"] = []
	const skipped: EntityRegistryYamlImportResponse["skipped"] = []
	const errors: EntityRegistryYamlImportResponse["errors"] = []

	for (const item of parsed) {
		if (!item.ok || !item.def) {
			errors.push({ id: null, error: item.error ?? "unknown parse error" })
			continue
		}
		const existing = db.getEntityDefinition(args.tenantId, item.def.id, { includeRetired: true })
		const created = existing === null
		if (args.dryRun) {
			saved.push({ id: item.def.id, version: existing ? existing.version + 1 : 1, created })
			continue
		}
		try {
			const result = db.saveEntityDefinition({ tenantId: args.tenantId, def: { ...item.def, tenantId: args.tenantId }, actor: args.actor, reason: args.reason })
			saved.push({ id: result.id, version: result.version, created })
			broadcast({ type: EventType.EntityRegistryImported, data: { tenantId: args.tenantId, id: result.id, version: result.version, created, actor: args.actor } })
		} catch (error) {
			if (error instanceof db.EntityRegistryValidationError) {
				errors.push({ id: item.def.id, error: error.result })
			} else {
				errors.push({ id: item.def.id, error: (error as Error).message })
			}
		}
	}

	return { ok: errors.length === 0, saved, skipped, errors, dryRun: args.dryRun }
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

	app.get<{
		Params: { id: string }
		Querystring: { flowPreset?: string; serviceProfileRef?: string; environmentPolicyRef?: string }
	}>("/api/entity-registry/entities/:id/scaffold-sync-definition", async (req, reply): Promise<EntityRegistrySyncDefinitionScaffoldResponse | { error: string; stderr?: string[] }> => {
		if (!req.session?.isAdmin) { reply.code(403); return { error: "admin only" } }
		if (!projectRoot) { reply.code(500); return { error: "projectRoot not configured" } }
		const tenantId = resolveTenant(req)
		const def = db.getEntityDefinition(tenantId, req.params.id, { includeRetired: true })
		if (!def) { reply.code(404); return { error: `entity not found: ${req.params.id}` } }

		const tempDir = await mkdtemp(join(tmpdir(), "mia-entity-registry-scaffold-"))
		const inputPath = join(tempDir, `${req.params.id}.json`)
		const scriptPath = resolve(projectRoot, "scripts", "scaffold-sync-definition.mjs")
		try {
			await writeFile(inputPath, `${JSON.stringify(def, null, 2)}\n`, "utf-8")
			const args = [scriptPath, "--input", inputPath, "--entity", req.params.id]
			if (req.query.flowPreset) args.push("--flow-preset", req.query.flowPreset)
			if (req.query.serviceProfileRef) args.push("--service-profile", req.query.serviceProfileRef)
			if (req.query.environmentPolicyRef) args.push("--environment-policy", req.query.environmentPolicyRef)

			const { stdout, stderr } = await execFileAsync(process.execPath, args, {
				cwd: projectRoot,
				maxBuffer: 1024 * 1024,
			})
			const stderrLines = stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
			audit(req, "entity_registry.sync_definition_scaffolded", {
				tenantId,
				id: req.params.id,
				flowPreset: req.query.flowPreset ?? null,
				serviceProfileRef: req.query.serviceProfileRef ?? "default",
				environmentPolicyRef: req.query.environmentPolicyRef ?? "default",
			})
			return {
				suggestedPath: `sync-definitions/entities/${req.params.id}.json`,
				definition: JSON.parse(stdout) as EntityRegistrySyncDefinitionScaffoldResponse["definition"],
				stderr: stderrLines,
			}
		} catch (error) {
			const stderrLines = typeof error === "object" && error && "stderr" in error && typeof error.stderr === "string"
				? error.stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
				: []
			reply.code(400)
			return { error: error instanceof Error ? error.message : String(error), stderr: stderrLines }
		} finally {
			await rm(tempDir, { recursive: true, force: true })
		}
	})

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

	app.post<{ Body: EntityRegistryDocumentImportRequest }>("/api/entity-registry/entities/import", async (req, reply): Promise<EntityRegistryYamlImportResponse | { error: string }> => {
		if (!req.session?.isAdmin) { reply.code(403); return { error: "admin only" } }
		if (typeof req.body?.content !== "string" || req.body.content.trim() === "") { reply.code(400); return { error: "'content' body is required" } }
		if (req.body.format !== "yaml" && req.body.format !== "json") { reply.code(400); return { error: "'format' must be 'yaml' or 'json'" } }
		if (!req.body.reason || req.body.reason.trim() === "") { reply.code(400); return { error: "'reason' is required" } }
		const tenantId = resolveTenant(req)
		const dryRun = Boolean(req.body.dryRun)
		const result = importEntitiesFromText({
			tenantId,
			actor: req.session.upn,
			reason: req.body.reason,
			content: req.body.content,
			format: req.body.format,
			dryRun,
		})

		if (!dryRun) {
			audit(req, "entity_registry.imported", { tenantId, format: req.body.format, savedCount: result.saved.length, errorCount: result.errors.length })
		}

		return result
	})

	app.post<{ Body: { yaml: string; reason: string; dryRun?: boolean } }>("/api/entity-registry/entities/import-yaml", async (req, reply): Promise<EntityRegistryYamlImportResponse | { error: string }> => {
		if (!req.session?.isAdmin) { reply.code(403); return { error: "admin only" } }
		if (typeof req.body?.yaml !== "string" || req.body.yaml.trim() === "") { reply.code(400); return { error: "'yaml' body is required" } }
		if (!req.body.reason || req.body.reason.trim() === "") { reply.code(400); return { error: "'reason' is required" } }
		const tenantId = resolveTenant(req)
		const dryRun = Boolean(req.body.dryRun)
		const result = importEntitiesFromText({
			tenantId,
			actor: req.session.upn,
			reason: req.body.reason,
			content: req.body.yaml,
			format: "yaml",
			dryRun,
		})
		if (!dryRun) {
			audit(req, "entity_registry.imported", { tenantId, format: "yaml", savedCount: result.saved.length, errorCount: result.errors.length })
		}
		return result
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
