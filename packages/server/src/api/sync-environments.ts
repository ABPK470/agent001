/**
 * Sync-environment transport routes.
 */

import { type AgentHost } from "@mia/agent"
import { ENV_ACCESS_MODES, getEnvironments, isEnvAccessMode, replaceEnvironments, withPermissionDefaults, type EnvOperation, type SyncEnvironment } from "@mia/sync"
import type { FastifyInstance, FastifyRequest } from "fastify"
import * as db from "../adapters/persistence/sqlite.js"
import { refreshEnvDerivedPolicies } from "../domain/policy/policy-seeder.js"

const VALID_OPS: EnvOperation[] = ["query_read", "schema_introspect", "sync_preview", "sync_execute", "ddl", "dml"]

type Editable = Pick<SyncEnvironment, "defaultAccessMode" | "allowedOperations" | "denyDml" | "denyDdl" | "approvalRequiredOperations" | "syncAllowlist">

function sanitise(body: Record<string, unknown>): Partial<Editable> | string {
	const out: Partial<Editable> = {}
	if (body["defaultAccessMode"] !== undefined) {
		if (!isEnvAccessMode(body["defaultAccessMode"])) return `defaultAccessMode must be one of ${ENV_ACCESS_MODES.join("|")}`
		out.defaultAccessMode = body["defaultAccessMode"]
	}
	if (body["allowedOperations"] !== undefined) {
		if (!Array.isArray(body["allowedOperations"])) return "allowedOperations must be an array"
		for (const op of body["allowedOperations"] as string[]) if (!VALID_OPS.includes(op as EnvOperation)) return `unknown operation "${op}"`
		out.allowedOperations = body["allowedOperations"] as EnvOperation[]
	}
	if (body["approvalRequiredOperations"] !== undefined) {
		if (!Array.isArray(body["approvalRequiredOperations"])) return "approvalRequiredOperations must be an array"
		for (const op of body["approvalRequiredOperations"] as string[]) if (!VALID_OPS.includes(op as EnvOperation)) return `unknown operation "${op}"`
		out.approvalRequiredOperations = body["approvalRequiredOperations"] as EnvOperation[]
	}
	if (body["denyDml"] !== undefined) {
		if (typeof body["denyDml"] !== "boolean") return "denyDml must be boolean"
		out.denyDml = body["denyDml"]
	}
	if (body["denyDdl"] !== undefined) {
		if (typeof body["denyDdl"] !== "boolean") return "denyDdl must be boolean"
		out.denyDdl = body["denyDdl"]
	}
	if (body["syncAllowlist"] !== undefined) {
		if (!Array.isArray(body["syncAllowlist"])) return "syncAllowlist must be an array of UPN strings"
		out.syncAllowlist = body["syncAllowlist"].map(String)
	}
	return out
}

function audit(req: FastifyRequest, action: string, detail: Record<string, unknown>): void {
	try {
		db.saveAdminAudit({ actor: req.session.upn, action, detail: JSON.stringify(detail), timestamp: new Date().toISOString(), scope_id: "sync-environments" })
	} catch (error) {
		console.warn("[sync-envs] audit_log write failed:", error instanceof Error ? error.message : error)
	}
}

function refreshRegistryFor(host: AgentHost, name: string): void {
	const override = db.getSyncEnvOverride(name)
	if (!override) return
	let parsed: Partial<SyncEnvironment>
	try { parsed = JSON.parse(override.overrides_json) as Partial<SyncEnvironment> } catch { return }
	const next = getEnvironments(host).map((env) => env.name === name ? withPermissionDefaults({ ...env, ...parsed, name: env.name }) : env)
	replaceEnvironments(host, next)
}

export function registerSyncEnvironmentRoutes(app: FastifyInstance, host: AgentHost): void {
	app.get("/api/sync-environments", async (req, reply) => {
		if (!req.session?.isAdmin) { reply.code(403); return { error: "admin only" } }
		const overrides = new Map(db.listSyncEnvOverrides().map((row) => [row.name, row]))
		return getEnvironments(host).map((env) => {
			const o = overrides.get(env.name)
			let parsed: Record<string, unknown> = {}
			if (o) {
				try { parsed = JSON.parse(o.overrides_json) as Record<string, unknown> } catch {}
			}
			return {
				name: env.name,
				displayName: env.displayName,
				role: env.role,
				defaultAccessMode: env.defaultAccessMode,
				allowedOperations: env.allowedOperations,
				denyDml: env.denyDml,
				denyDdl: env.denyDdl,
				approvalRequiredOperations: env.approvalRequiredOperations,
				syncAllowlist: env.syncAllowlist,
				override: o ? { fields: parsed, updatedAt: o.updated_at, updatedBy: o.updated_by } : null,
			}
		})
	})

	app.put<{ Params: { name: string }; Body: Record<string, unknown> }>("/api/sync-environments/:name", async (req, reply) => {
		if (!req.session?.isAdmin) { reply.code(403); return { error: "admin only" } }
		const env = getEnvironments(host).find((entry) => entry.name === req.params.name)
		if (!env) { reply.code(404); return { error: `unknown env "${req.params.name}"` } }
		const sanitised = sanitise(req.body ?? {})
		if (typeof sanitised === "string") { reply.code(400); return { error: sanitised } }
		const prev = db.getSyncEnvOverride(req.params.name)
		let prevParsed: Record<string, unknown> = {}
		if (prev) {
			try { prevParsed = JSON.parse(prev.overrides_json) as Record<string, unknown> } catch {}
		}
		const merged = { ...prevParsed, ...sanitised }
		db.saveSyncEnvOverride({ name: req.params.name, overrides_json: JSON.stringify(merged), updated_at: new Date().toISOString(), updated_by: req.session.upn })
		refreshRegistryFor(host, req.params.name)
		refreshEnvDerivedPolicies(host, req.params.name)
		audit(req, "sync_env.update", { name: req.params.name, fields: sanitised })
		return { ok: true }
	})

	app.delete<{ Params: { name: string } }>("/api/sync-environments/:name", async (req, reply) => {
		if (!req.session?.isAdmin) { reply.code(403); return { error: "admin only" } }
		db.deleteSyncEnvOverride(req.params.name)
		refreshEnvDerivedPolicies(host, req.params.name)
		audit(req, "sync_env.reset", { name: req.params.name })
		return { ok: true }
	})
}
