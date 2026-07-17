/**
 * Connector transport routes — admin-only CRUD + validate + export/import.
 *
 * Secret config fields (type "password") are masked with SECRET_MASK on every
 * read (list / export). On update, a secret field whose posted value equals
 * SECRET_MASK is preserved from the stored row, so round-tripping a masked
 * form never clobbers the real credential.
 */

import { type AgentHost } from "@mia/agent"
import {
  CONNECTOR_KINDS,
  getConnectorKind,
  isConnectorKindId,
  maskConnectorConfig,
  SECRET_MASK,
  toConnectorId,
  validateConnectorConfig,
  withConnectorConfigDefaults,
  type Connector,
  type ConnectorAdmin,
  type ConnectorKindId,
} from "@mia/shared-types"
import type { FastifyInstance, FastifyRequest } from "fastify"
import * as db from "../../../infra/persistence/sqlite.js"

type ConfigValue = string | number | boolean | null
type ConfigMap = Record<string, ConfigValue>

function parseRow(row: db.DbConnector): Connector {
  const body = JSON.parse(row.body_json) as Connector
  return {
    ...body,
    id: row.id,
    kind: row.kind as ConnectorKindId,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  }
}

function toAdmin(connector: Connector): ConnectorAdmin {
  const kind = getConnectorKind(connector.kind)
  return {
    ...connector,
    config: maskConnectorConfig(connector.kind, connector.config),
    kindEnabled: kind?.enabled ?? false,
  }
}

function serialise(
  connector: Connector,
  actor: string | null,
  createdAt?: string,
): db.DbConnector {
  const now = new Date().toISOString()
  return {
    id: connector.id,
    kind: connector.kind,
    body_json: JSON.stringify(connector),
    enabled: connector.enabled ? 1 : 0,
    created_at: createdAt ?? now,
    updated_at: now,
    updated_by: actor,
  }
}

function mergeSecretsOnUpdate(
  kind: ConnectorKindId,
  posted: ConfigMap,
  stored: ConfigMap,
): ConfigMap {
  const out: ConfigMap = { ...posted }
  for (const field of getConnectorKind(kind)?.configSchema ?? []) {
    if (field.type !== "password") continue
    const value = out[field.key]
    if (value === SECRET_MASK || value === undefined || value === null || value === "") {
      out[field.key] = stored[field.key] ?? null
    }
  }
  return out
}

function coerceConfigValue(
  value: unknown,
  type: "text" | "password" | "number" | "boolean" | "url",
): ConfigValue {
  if (value === null || value === undefined) return null
  if (type === "number") {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  if (type === "boolean") return Boolean(value)
  return typeof value === "string" ? value : String(value)
}

function sanitiseConfig(
  kind: ConnectorKindId,
  raw: unknown,
): ConfigMap | string {
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) {
    return "config must be an object"
  }
  const schema = getConnectorKind(kind)?.configSchema ?? []
  const out: ConfigMap = {}
  for (const field of schema) {
    out[field.key] = coerceConfigValue((raw as Record<string, unknown>)[field.key], field.type)
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
      scope_id: "connectors",
    })
  } catch (error) {
    console.warn("[connectors] audit_log write failed:", error instanceof Error ? error.message : error)
  }
}

export function registerConnectorRoutes(app: FastifyInstance, _host: AgentHost): void {
  app.get("/api/connectors", async (req, reply) => {
    if (!req.session?.isAdmin) {
      reply.code(403)
      return { error: "admin only" }
    }
    return db.listConnectors().map(parseRow).map(toAdmin)
  })

  app.get("/api/connectors/kinds", async (req, reply) => {
    if (!req.session?.isAdmin) {
      reply.code(403)
      return { error: "admin only" }
    }
    return CONNECTOR_KINDS
  })

  app.post<{ Body: Record<string, unknown> }>(
    "/api/connectors/validate",
    async (req, reply) => {
      if (!req.session?.isAdmin) {
        reply.code(403)
        return { error: "admin only" }
      }
      const kind = req.body?.["kind"]
      if (!isConnectorKindId(kind)) return { ok: false, error: "unknown kind", missing: [] }
      const config = sanitiseConfig(kind, req.body?.["config"])
      if (typeof config === "string") return { ok: false, error: config, missing: [] }
      return validateConnectorConfig(kind, config)
    },
  )

  app.post<{ Body: Record<string, unknown> }>(
    "/api/connectors",
    async (req, reply) => {
      if (!req.session?.isAdmin) {
        reply.code(403)
        return { error: "admin only" }
      }
      const kindRaw = req.body?.["kind"]
      if (!isConnectorKindId(kindRaw)) {
        reply.code(400)
        return { error: "unknown or missing kind" }
      }
      const kind = getConnectorKind(kindRaw)!
      if (!kind.enabled) {
        reply.code(400)
        return { error: `connector kind "${kindRaw}" is not enabled yet` }
      }
      const name = typeof req.body?.["name"] === "string" ? req.body.name.trim() : ""
      if (!name) {
        reply.code(400)
        return { error: "name is required" }
      }
      const id =
        typeof req.body?.["id"] === "string" && req.body.id.trim()
          ? toConnectorId(req.body.id)
          : toConnectorId(name)
      if (!id) {
        reply.code(400)
        return { error: "id must be a non-empty slug" }
      }
      if (db.getConnector(id)) {
        reply.code(409)
        return { error: `connector already exists: ${id}` }
      }
      const config = sanitiseConfig(kindRaw, req.body?.["config"])
      if (typeof config === "string") {
        reply.code(400)
        return { error: config }
      }
      const withDefaults = withConnectorConfigDefaults(kindRaw, config)
      const validation = validateConnectorConfig(kindRaw, withDefaults)
      if (!validation.ok) {
        reply.code(400)
        return { error: validation.error }
      }
      const displayName =
        typeof req.body?.["displayName"] === "string" && req.body.displayName.trim()
          ? req.body.displayName.trim()
          : name
      const enabled = req.body?.["enabled"] !== false
      const now = new Date().toISOString()
      const connector: Connector = {
        id,
        kind: kindRaw,
        name,
        displayName,
        config: withDefaults,
        enabled,
        createdAt: now,
        updatedAt: now,
        updatedBy: req.session.upn,
      }
      db.saveConnector(serialise(connector, req.session.upn))
      audit(req, "connector.create", { id, kind: kindRaw, name })
      return { ok: true, id }
    },
  )

  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>(
    "/api/connectors/:id",
    async (req, reply) => {
      if (!req.session?.isAdmin) {
        reply.code(403)
        return { error: "admin only" }
      }
      const row = db.getConnector(req.params.id)
      if (!row) {
        reply.code(404)
        return { error: `unknown connector "${req.params.id}"` }
      }
      const existing = parseRow(row)
      const body = req.body ?? {}
      const configPosted = sanitiseConfig(existing.kind, body["config"])
      if (typeof configPosted === "string") {
        reply.code(400)
        return { error: configPosted }
      }
      const config = mergeSecretsOnUpdate(existing.kind, configPosted, existing.config)
      const validation = validateConnectorConfig(existing.kind, config)
      if (!validation.ok) {
        reply.code(400)
        return { error: validation.error }
      }
      const name =
        typeof body["name"] === "string" && body["name"].trim() ? body["name"].trim() : existing.name
      const displayName =
        typeof body["displayName"] === "string" && body["displayName"].trim()
          ? body["displayName"].trim()
          : name
      const enabled = body["enabled"] === undefined ? existing.enabled : body["enabled"] !== false
      const next: Connector = {
        ...existing,
        name,
        displayName,
        config,
        enabled,
        updatedAt: new Date().toISOString(),
        updatedBy: req.session.upn,
      }
      db.saveConnector(serialise(next, req.session.upn, existing.createdAt))
      audit(req, "connector.update", { id: req.params.id, fields: Object.keys(body) })
      return { ok: true }
    },
  )

  app.delete<{ Params: { id: string } }>("/api/connectors/:id", async (req, reply) => {
    if (!req.session?.isAdmin) {
      reply.code(403)
      return { error: "admin only" }
    }
    if (!db.getConnector(req.params.id)) {
      reply.code(404)
      return { error: `unknown connector "${req.params.id}"` }
    }
    db.deleteConnector(req.params.id)
    audit(req, "connector.delete", { id: req.params.id })
    return { ok: true }
  })

  app.get<{ Querystring: { includeSecrets?: string } }>(
    "/api/connectors/export",
    async (req, reply) => {
      if (!req.session?.isAdmin) {
        reply.code(403)
        return { error: "admin only" }
      }
      const includeSecrets = req.query?.includeSecrets === "1" || req.query?.includeSecrets === "true"
      const connectors = db.listConnectors().map(parseRow)
      return {
        version: 1,
        connectors: connectors.map((c) => ({
          id: c.id,
          kind: c.kind,
          name: c.name,
          displayName: c.displayName,
          enabled: c.enabled,
          config: includeSecrets ? c.config : maskConnectorConfig(c.kind, c.config),
        })),
      }
    },
  )

  app.post<{ Body: { version?: number; connectors?: Array<Record<string, unknown>> } }>(
    "/api/connectors/import",
    async (req, reply) => {
      if (!req.session?.isAdmin) {
        reply.code(403)
        return { error: "admin only" }
      }
      const payload = req.body ?? {}
      if (payload.version !== 1) {
        reply.code(400)
        return { error: "unsupported import version" }
      }
      const list = Array.isArray(payload.connectors) ? payload.connectors : []
      let imported = 0
      for (const entry of list) {
        const kind = entry["kind"]
        if (!isConnectorKindId(kind)) continue
        const id = typeof entry["id"] === "string" ? toConnectorId(entry["id"]) : ""
        const name = typeof entry["name"] === "string" ? entry["name"].trim() : id
        if (!id || !name) continue
        const config = sanitiseConfig(kind, entry["config"])
        if (typeof config === "string") continue
        const existing = db.getConnector(id)
        const resolvedConfig =
          existing && entry["config"] !== undefined
            ? mergeSecretsOnUpdate(kind, config, parseRow(existing).config)
            : withConnectorConfigDefaults(kind, config)
        const now = new Date().toISOString()
        const connector: Connector = {
          id,
          kind,
          name,
          displayName:
            typeof entry["displayName"] === "string" && entry["displayName"].trim()
              ? entry["displayName"].trim()
              : name,
          config: resolvedConfig,
          enabled: entry["enabled"] !== false,
          createdAt: existing?.created_at ?? now,
          updatedAt: now,
          updatedBy: req.session.upn,
        }
        db.saveConnector(serialise(connector, req.session.upn, existing?.created_at))
        imported++
      }
      audit(req, "connector.import", { count: imported })
      return { ok: true, imported }
    },
  )
}
