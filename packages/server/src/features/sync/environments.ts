/**
 * Sync-environment transport routes.
 */

import { type AgentHost } from "@mia/agent"
import { EventType } from "@mia/shared-enums"
import {
  ENV_ACCESS_MODES,
  ENV_ROLES,
  isEnvAccessMode,
  isEnvRole,
  type EnvOperation,
  type SyncEnvironment
} from "@mia/sync"
import type { FastifyInstance, FastifyRequest } from "fastify"
import * as db from "../../platform/persistence/sqlite.js"
import { refreshEnvDerivedPolicies } from "../policies/policy-seeder.js"
import { rebuildLiveSyncEnvironments } from "./live-environments.js"
import { broadcast } from "../../platform/events/broadcaster.js"

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
  | "defaultAccessMode"
  | "allowedOperations"
  | "denyDml"
  | "denyDdl"
  | "approvalRequiredOperations"
  | "syncAllowlist"
  | "allowedSyncTargets"
>

function sanitise(body: Record<string, unknown>): Partial<Editable> | string {
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
  if (body["syncAllowlist"] !== undefined) {
    if (!Array.isArray(body["syncAllowlist"])) return "syncAllowlist must be an array of UPN strings"
    out.syncAllowlist = body["syncAllowlist"].map(String)
  }
  if (body["allowedSyncTargets"] !== undefined) {
    if (body["allowedSyncTargets"] !== null && !Array.isArray(body["allowedSyncTargets"]))
      return "allowedSyncTargets must be null or an array of environment names"
    out.allowedSyncTargets =
      body["allowedSyncTargets"] === null ? null : (body["allowedSyncTargets"] as unknown[]).map(String)
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
): SyncEnvironment & { updatedAt: string; updatedBy: string | null } {
  const env = JSON.parse(row.body_json) as SyncEnvironment
  return {
    ...env,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by
  }
}

function hasConnection(host: AgentHost, name: string): boolean {
  return host.mssql.databases.has(name)
}

function defaultAccessModeForName(name: string): SyncEnvironment["defaultAccessMode"] {
  return /\bprod\b|\buat\b|\bstag(e|ing)?\b/i.test(name) ? "read_only" : "read_write"
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
      if (!hasConnection(host, name)) {
        reply.code(400)
        return { error: `unknown MSSQL connection "${name}"` }
      }
      if (db.getSyncEnvironment(name)) {
        reply.code(409)
        return { error: `environment already exists: ${name}` }
      }
      const sanitised = sanitise(req.body ?? {})
      if (typeof sanitised === "string") {
        reply.code(400)
        return { error: sanitised }
      }
      const env: SyncEnvironment = {
        name,
        displayName: sanitised.displayName ?? name,
        color: sanitised.color ?? "slate",
        role: sanitised.role ?? "both",
        ringOrder: sanitised.ringOrder ?? 0,
        agentServiceBaseUrl: sanitised.agentServiceBaseUrl ?? null,
        etlServiceBaseUrl: sanitised.etlServiceBaseUrl ?? null,
        gateServiceBaseUrl: sanitised.gateServiceBaseUrl ?? null,
        defaultAccessMode: sanitised.defaultAccessMode ?? defaultAccessModeForName(name),
        allowedOperations: sanitised.allowedOperations ?? [],
        denyDml: sanitised.denyDml ?? false,
        denyDdl: sanitised.denyDdl ?? false,
        approvalRequiredOperations: sanitised.approvalRequiredOperations ?? [],
        syncAllowlist: sanitised.syncAllowlist ?? [],
        allowedSyncTargets: sanitised.allowedSyncTargets ?? []
      }
      db.saveSyncEnvironment(serialiseEnvironment(env, req.session.upn))
      rebuildLiveSyncEnvironments(host)
      refreshEnvDerivedPolicies(host, name)
      audit(req, "sync_env.create", { name, fields: sanitised })
      broadcast({
        type: EventType.SyncEnvUpdate,
        data: { name, action: "create", actor: req.session.upn }
      })
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
      const sanitised = sanitise(req.body ?? {})
      if (typeof sanitised === "string") {
        reply.code(400)
        return { error: sanitised }
      }
      const next = {
        ...(JSON.parse(row.body_json) as SyncEnvironment),
        ...sanitised,
        name: req.params.name
      }
      db.saveSyncEnvironment(serialiseEnvironment(next, req.session.upn, row.created_at))
      rebuildLiveSyncEnvironments(host)
      refreshEnvDerivedPolicies(host, req.params.name)
      audit(req, "sync_env.update", { name: req.params.name, fields: sanitised })
      broadcast({
        type: EventType.SyncEnvUpdate,
        data: { name: req.params.name, action: "update", actor: req.session.upn }
      })
      return { ok: true }
    }
  )

  app.delete<{ Params: { name: string } }>("/api/sync-environments/:name", async (req, reply) => {
    if (!req.session?.isAdmin) {
      reply.code(403)
      return { error: "admin only" }
    }
    db.deleteSyncEnvironment(req.params.name)
    rebuildLiveSyncEnvironments(host)
    audit(req, "sync_env.delete", { name: req.params.name })
    broadcast({
      type: EventType.SyncEnvUpdate,
      data: { name: req.params.name, action: "delete", actor: req.session.upn }
    })
    return { ok: true }
  })
}
