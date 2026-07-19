/**
 * Sync-environment transport routes.
 */

import { type AgentHost } from "@mia/agent"
import { EventType } from "@mia/shared-enums"
import {
  ENV_ACCESS_MODES,
  ENV_ROLES,
  findRemovedSyncEnvironmentFields,
  isEnvAccessMode,
  isEnvRole,
  normalizeStoredSyncEnvironment,
  removedSyncEnvironmentFieldError,
  type EnvOperation,
  type SyncEnvironment,
  withPermissionDefaults,
} from "@mia/sync"
import type { FastifyInstance, FastifyRequest } from "fastify"
import { broadcast } from "../../../infra/events/broadcaster.js"
import * as db from "../../../infra/persistence/sqlite.js"
import { recordSyncCatalogChange } from "../../platform/service/sync-catalog-versioning.js"
import { refreshEnvDerivedPolicies } from "../../policies/service/policy-seeder.js"
import { isBuiltinSyncEnvironment } from "../types/builtin-sync-environments.js"
import { rebuildLiveSyncEnvironments } from "../state/live-environments.js"

const VALID_OPS: EnvOperation[] = [
  "query_read",
  "schema_introspect",
  "sync_preview",
  "sync_execute",
  "ddl",
  "dml"
]

type Editable = Pick<
  SyncEnvironment,
  | "displayName"
  | "color"
  | "role"
  | "ringOrder"
  | "agentServiceBaseUrl"
  | "etlServiceBaseUrl"
  | "gateServiceBaseUrl"
  | "serviceUrls"
  | "defaultAccessMode"
  | "allowedOperations"
  | "denyDml"
  | "denyDdl"
  | "approvalRequiredOperations"
  | "allowedSyncEnvironments"
  | "connectorId"
>

function sanitise(body: Record<string, unknown>): Partial<Editable> | string {
  const removed = findRemovedSyncEnvironmentFields(body)
  if (removed.length > 0) {
    return removedSyncEnvironmentFieldError(removed[0]!, "request")
  }

  const out: Partial<Editable> = {}
  if (body["displayName"] !== undefined) {
    if (typeof body["displayName"] !== "string" || body["displayName"].trim() === "")
      return "displayName must be a non-empty string"
    out.displayName = body["displayName"].trim()
  }
  if (body["color"] !== undefined) {
    if (typeof body["color"] !== "string" || body["color"].trim() === "")
      return "color must be a non-empty string"
    out.color = body["color"].trim()
  }
  if (body["role"] !== undefined) {
    if (!isEnvRole(body["role"])) return `role must be one of ${ENV_ROLES.join("|")}`
    out.role = body["role"]
  }
  if (body["ringOrder"] !== undefined) {
    if (typeof body["ringOrder"] !== "number" || !Number.isFinite(body["ringOrder"]))
      return "ringOrder must be a number"
    out.ringOrder = body["ringOrder"]
  }
  for (const field of ["agentServiceBaseUrl", "etlServiceBaseUrl", "gateServiceBaseUrl"] as const) {
    if (body[field] !== undefined) {
      if (body[field] !== null && typeof body[field] !== "string") return `${field} must be null or a string`
      out[field] = body[field] as string | null
    }
  }
  if (body["serviceUrls"] !== undefined) {
    if (body["serviceUrls"] === null || typeof body["serviceUrls"] !== "object" || Array.isArray(body["serviceUrls"]))
      return "serviceUrls must be an object of string|null values"
    const map: Record<string, string | null> = {}
    for (const [rawKey, rawValue] of Object.entries(body["serviceUrls"] as Record<string, unknown>)) {
      const key = rawKey.trim().toLowerCase()
      if (!key) continue
      if (rawValue === null) {
        map[key] = null
        continue
      }
      if (typeof rawValue !== "string") return `serviceUrls.${key} must be a string or null`
      map[key] = rawValue.trim() || null
    }
    out.serviceUrls = map
  }
  if (body["defaultAccessMode"] !== undefined) {
    if (!isEnvAccessMode(body["defaultAccessMode"]))
      return `defaultAccessMode must be one of ${ENV_ACCESS_MODES.join("|")}`
    out.defaultAccessMode = body["defaultAccessMode"]
  }
  if (body["allowedOperations"] !== undefined) {
    if (!Array.isArray(body["allowedOperations"])) return "allowedOperations must be an array"
    for (const op of body["allowedOperations"] as string[])
      if (!VALID_OPS.includes(op as EnvOperation)) return `unknown operation "${op}"`
    out.allowedOperations = body["allowedOperations"] as EnvOperation[]
  }
  if (body["approvalRequiredOperations"] !== undefined) {
    if (!Array.isArray(body["approvalRequiredOperations"]))
      return "approvalRequiredOperations must be an array"
    for (const op of body["approvalRequiredOperations"] as string[])
      if (!VALID_OPS.includes(op as EnvOperation)) return `unknown operation "${op}"`
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
  if (body["allowedSyncEnvironments"] !== undefined) {
    if (body["allowedSyncEnvironments"] !== null && !Array.isArray(body["allowedSyncEnvironments"]))
      return "allowedSyncEnvironments must be null or an array of environment names"
    out.allowedSyncEnvironments =
      body["allowedSyncEnvironments"] === null ? null : (body["allowedSyncEnvironments"] as unknown[]).map(String)
  }
  if (body["connectorId"] !== undefined) {
    if (typeof body["connectorId"] !== "string" || body["connectorId"].trim() === "")
      return "connectorId must be a non-empty string"
    out.connectorId = (body["connectorId"] as string).trim()
  }
  return out
}

function audit(req: FastifyRequest, action: string, detail: Record<string, unknown>): void {
  try {
    db.saveAdminAudit({
      actor: req.session.upn,
      action,
      detail: JSON.stringify(detail),
      timestamp: new Date().toISOString(),
      scope_id: "sync-environments"
    })
  } catch (error) {
    console.warn("[sync-envs] audit_log write failed:", error instanceof Error ? error.message : error)
  }
}

function serialiseEnvironment(
  env: SyncEnvironment,
  actor: string | null,
  createdAt?: string
): db.DbSyncEnvironment {
  const now = new Date().toISOString()
  return {
    name: env.name,
    body_json: JSON.stringify(env),
    created_at: createdAt ?? now,
    updated_at: now,
    updated_by: actor
  }
}

function parseEnvironmentRow(
  row: db.DbSyncEnvironment
): SyncEnvironment & { updatedAt: string; updatedBy: string | null; builtIn: boolean } {
  const env = normalizeStoredSyncEnvironment(row.name, JSON.parse(row.body_json) as Record<string, unknown>)
  return {
    ...env,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
    builtIn: isBuiltinSyncEnvironment(env.name),
  }
}

function requireBuiltinEditUnlock(
  name: string,
  opts: { allowBuiltinEdit?: boolean },
): string | null {
  if (!isBuiltinSyncEnvironment(name)) return null
  if (opts.allowBuiltinEdit === true) return null
  return `Built-in sync environment "${name}" is locked. Confirm allowBuiltinEdit to modify.`
}

function allowBuiltinFromRequest(req: FastifyRequest): boolean {
  const query = req.query as { allowBuiltinEdit?: string }
  if (query.allowBuiltinEdit === "1" || query.allowBuiltinEdit === "true") return true
  const body = (req.body ?? {}) as Record<string, unknown>
  return body.allowBuiltinEdit === true
}

function defaultAccessModeForName(name: string): SyncEnvironment["defaultAccessMode"] {
  return /\bprod\b|\buat\b|\bstag(e|ing)?\b/i.test(name) ? "read_only" : "read_write"
}

/** Live FK: connectorId must be a persisted, enabled MSSQL connector. */
function resolveMssqlConnector(connectorId: string): db.DbConnector | undefined {
  const row = db.getConnector(connectorId)
  return row && row.kind === "mssql" && row.enabled === 1 ? row : undefined
}

export function registerSyncEnvironmentRoutes(app: FastifyInstance, host: AgentHost): void {
  app.get("/api/sync-environments", async (req, reply) => {
    if (!req.session?.isAdmin) {
      reply.code(403)
      return { error: "admin only" }
    }
    rebuildLiveSyncEnvironments(host)
    return db.listSyncEnvironments().map(parseEnvironmentRow)
  })

  app.post<{ Body: { name?: string } & Record<string, unknown> }>(
    "/api/sync-environments",
    async (req, reply) => {
      if (!req.session?.isAdmin) {
        reply.code(403)
        return { error: "admin only" }
      }
      const name = typeof req.body?.name === "string" ? req.body.name.trim() : ""
      if (!name) {
        reply.code(400)
        return { error: "name is required" }
      }
      const sanitised = sanitise(req.body ?? {})
      if (typeof sanitised === "string") {
        reply.code(400)
        return { error: sanitised }
      }
      const connectorId = sanitised.connectorId
      if (!connectorId) {
        reply.code(400)
        return { error: "connectorId is required" }
      }
      const connector = resolveMssqlConnector(connectorId)
      if (!connector) {
        reply.code(400)
        return {
          error: `MSSQL connector "${connectorId}" is missing or disabled — enable it in Connectors first`,
        }
      }
      if (db.getSyncEnvironment(name)) {
        reply.code(409)
        return { error: `environment already exists: ${name}` }
      }
      const env = withPermissionDefaults({
        name,
        displayName: sanitised.displayName ?? name,
        color: sanitised.color ?? "slate",
        role: sanitised.role ?? "both",
        ringOrder: sanitised.ringOrder ?? 0,
        agentServiceBaseUrl: sanitised.agentServiceBaseUrl ?? null,
        etlServiceBaseUrl: sanitised.etlServiceBaseUrl ?? null,
        gateServiceBaseUrl: sanitised.gateServiceBaseUrl ?? null,
        defaultAccessMode: sanitised.defaultAccessMode ?? defaultAccessModeForName(name),
        ...(Array.isArray(sanitised.allowedOperations) && sanitised.allowedOperations.length > 0
          ? { allowedOperations: sanitised.allowedOperations }
          : {}),
        ...(sanitised.denyDml !== undefined ? { denyDml: sanitised.denyDml } : {}),
        ...(sanitised.denyDdl !== undefined ? { denyDdl: sanitised.denyDdl } : {}),
        approvalRequiredOperations: sanitised.approvalRequiredOperations ?? [],
        allowedSyncEnvironments: sanitised.allowedSyncEnvironments ?? [],
        ...(sanitised.serviceUrls ? { serviceUrls: sanitised.serviceUrls } : {}),
        connectorId,
      })
      db.saveSyncEnvironment(serialiseEnvironment(env, req.session.upn))
      rebuildLiveSyncEnvironments(host)
      refreshEnvDerivedPolicies(host, name)
      audit(req, "sync_env.create", { name, fields: sanitised })
      broadcast({
        type: EventType.SyncEnvUpdate,
        data: { name, action: "create", actor: req.session.upn }
      })
      recordSyncCatalogChange({ reason: `sync-env:create:${name}`, actor: req.session.upn })
      return { ok: true }
    }
  )

  app.put<{ Params: { name: string }; Body: Record<string, unknown> }>(
    "/api/sync-environments/:name",
    async (req, reply) => {
      if (!req.session?.isAdmin) {
        reply.code(403)
        return { error: "admin only" }
      }
      const row = db.getSyncEnvironment(req.params.name)
      if (!row) {
        reply.code(404)
        return { error: `unknown env "${req.params.name}"` }
      }
      const builtinLock = requireBuiltinEditUnlock(req.params.name, {
        allowBuiltinEdit: allowBuiltinFromRequest(req),
      })
      if (builtinLock) {
        reply.code(403)
        return { error: builtinLock }
      }
      const sanitised = sanitise(req.body ?? {})
      if (typeof sanitised === "string") {
        reply.code(400)
        return { error: sanitised }
      }
      if (sanitised.connectorId !== undefined) {
        if (!sanitised.connectorId) {
          reply.code(400)
          return { error: "connectorId is required" }
        }
        if (!resolveMssqlConnector(sanitised.connectorId)) {
          reply.code(400)
          return {
            error: `MSSQL connector "${sanitised.connectorId}" is missing or disabled — enable it in Connectors first`,
          }
        }
      }
      const env = withPermissionDefaults({
        ...normalizeStoredSyncEnvironment(req.params.name, JSON.parse(row.body_json) as Record<string, unknown>),
        ...sanitised,
        name: req.params.name,
      })
      db.saveSyncEnvironment(serialiseEnvironment(env, req.session.upn, row.created_at))
      rebuildLiveSyncEnvironments(host)
      refreshEnvDerivedPolicies(host, req.params.name)
      audit(req, "sync_env.update", { name: req.params.name, fields: sanitised })
      broadcast({
        type: EventType.SyncEnvUpdate,
        data: { name: req.params.name, action: "update", actor: req.session.upn }
      })
      recordSyncCatalogChange({ reason: `sync-env:update:${req.params.name}`, actor: req.session.upn })
      return { ok: true }
    }
  )

  app.delete<{ Params: { name: string }; Querystring: { allowBuiltinEdit?: string } }>(
    "/api/sync-environments/:name",
    async (req, reply) => {
    if (!req.session?.isAdmin) {
      reply.code(403)
      return { error: "admin only" }
    }
    const builtinLock = requireBuiltinEditUnlock(req.params.name, {
      allowBuiltinEdit: allowBuiltinFromRequest(req),
    })
    if (builtinLock) {
      reply.code(403)
      return { error: builtinLock }
    }
    db.deleteSyncEnvironment(req.params.name)
    rebuildLiveSyncEnvironments(host)
    audit(req, "sync_env.delete", { name: req.params.name })
    broadcast({
      type: EventType.SyncEnvUpdate,
      data: { name: req.params.name, action: "delete", actor: req.session.upn }
    })
    recordSyncCatalogChange({ reason: `sync-env:delete:${req.params.name}`, actor: req.session.upn })
    return { ok: true }
  })
}
