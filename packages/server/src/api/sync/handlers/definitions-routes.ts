/**
 * Entity registry transport routes.
 */

import { EventType } from "@mia/shared-enums"
import type {
  EntityRegistryDraftSuggestion,
  EntityRegistryTableSuggestion,
  EntityRegistrySyncFlowTemplateId,
  EntityRegistryYamlImportResponse,
  EntityRegistryDefinition,
  EntityRegistryPreviewYamlRequest,
} from "@mia/shared-types"
import {
  hasSyncDefinitionFlowTemplate,
  loadSyncDefinitionFlowTemplateCatalog,
  suggestEntityDraft,
  suggestEntityTable,
  validateEntityDefinition,
  type EntityDefinition,
  type Scd2Strategy
} from "@mia/sync"
import type { FastifyInstance, FastifyRequest } from "fastify"
import { broadcast } from "../../../infra/events/broadcaster.js"
import * as db from "../../../infra/persistence/sqlite.js"
import {
  entityToAuthoredSyncDefinition,
  formatAuthoredSyncJson,
  syncConfigInputFromDb,
} from "../types/authored-sync-document.js"
import {
  formatEntitiesYaml,
  formatEntityJson,
  formatEntityYaml,
  entityRunYamlFromConfig,
  parseEntitiesJson,
  parseEntitiesYaml
} from "../types/entity-yaml.js"
import { applyEntityRunYaml, validateEntityRunYaml } from "../service/apply-entity-run-yaml.js"
import {
  assertEntityExportable,
  assertTenantEntitiesExportable,
  EntityExportValidationError,
} from "../service/assert-entity-export.js"
import { loadAuthoringFlowCatalog } from "../service/definitions.js"
import { importAuthoredSyncFromText } from "../service/import-authored-sync.js"
import { loadCatalogSnapshotForSuggest } from "../service/load-catalog-for-suggest.js"
import { entityImportToGate } from "../../platform/service/import-gate.js"
import { recordSyncCatalogChange } from "../../platform/service/sync-catalog-versioning.js"

const DEFAULT_TENANT_ID = "_default"
function resolveTenant(req: FastifyRequest): string {
  const q = (req.query as Record<string, string> | undefined)?.["tenant"]
  if (q && req.session?.isAdmin) return q
  return DEFAULT_TENANT_ID
}

function audit(req: FastifyRequest, action: string, detail: Record<string, unknown>): void {
  try {
    db.saveAdminAudit({
      actor: req.session.upn,
      action,
      detail: JSON.stringify(detail),
      timestamp: new Date().toISOString(),
      scope_id: "entity-registry"
    })
  } catch (error) {
    console.warn("[entity-registry] audit_log write failed:", error instanceof Error ? error.message : error)
  }
}

function resolveFlowTemplateId(
  flowTemplateId: string | undefined,
  projectRoot: string
): EntityRegistrySyncFlowTemplateId | null {
  if (!flowTemplateId) return null
  return hasSyncDefinitionFlowTemplate(loadSyncDefinitionFlowTemplateCatalog(projectRoot), flowTemplateId)
    ? (flowTemplateId as EntityRegistrySyncFlowTemplateId)
    : null
}

function importEntitiesFromText(args: {
  tenantId: string
  actor: string
  reason: string
  content: string
  format: "yaml" | "json"
  dryRun: boolean
  projectRoot?: string
}): EntityRegistryYamlImportResponse {
  const parsed = args.format === "json" ? parseEntitiesJson(args.content) : parseEntitiesYaml(args.content)
  const saved: EntityRegistryYamlImportResponse["saved"] = []
  const skipped: EntityRegistryYamlImportResponse["skipped"] = []
  const rowErrors: EntityRegistryYamlImportResponse["rowErrors"] = []
  const preview: EntityRegistryYamlImportResponse["preview"] = []

  for (const item of parsed) {
    if (!item.ok || !item.def) {
      rowErrors.push({ id: null, error: item.error ?? "unknown parse error" })
      continue
    }
    if (item.run) {
      if (!args.projectRoot) {
        rowErrors.push({ id: item.def.id, error: "run block requires server projectRoot" })
        continue
      }
      const runError = validateEntityRunYaml(args.projectRoot, item.run)
      if (runError) {
        rowErrors.push({ id: item.def.id, error: runError })
        continue
      }
    }
    const defWithTenant = { ...item.def, tenantId: args.tenantId }
    const validation = validateEntityDefinition(defWithTenant)
    if (!validation.ok) {
      rowErrors.push({ id: item.def.id, error: validation })
      continue
    }
    const existing = db.getEntityDefinition(args.tenantId, item.def.id, { includeRetired: true })
    const created = existing === null
    if (args.dryRun) {
      saved.push({ id: item.def.id, version: existing ? existing.version + 1 : 1, created })
      preview.push({
        def: item.def as EntityRegistryDefinition,
        run: item.run
          ? { template: item.run.template, service: item.run.service, environment: item.run.environment }
          : null,
      })
      continue
    }
    try {
      const result = db.saveEntityDefinition({
        tenantId: args.tenantId,
        def: defWithTenant,
        actor: args.actor,
        reason: args.reason
      })
      saved.push({ id: result.id, version: result.version, created })
      if (item.run && args.projectRoot) {
        applyEntityRunYaml(args.projectRoot, args.tenantId, result.id, item.run, args.actor)
      }
      broadcast({
        type: EventType.EntityRegistryImported,
        data: {
          tenantId: args.tenantId,
          id: result.id,
          version: result.version,
          created,
          actor: args.actor
        }
      })
    } catch (error) {
      if (error instanceof db.EntityRegistryValidationError) {
        rowErrors.push({ id: item.def.id, error: error.result })
      } else {
        rowErrors.push({ id: item.def.id, error: (error as Error).message })
      }
    }
  }

  if (!args.dryRun && saved.length > 0) {
    recordSyncCatalogChange({
      tenantId: args.tenantId,
      reason: `entity-registry:import:${args.reason}`,
      actor: args.actor,
    })
  }

  const ok = rowErrors.length === 0
  const gate = entityImportToGate({ ok, dryRun: args.dryRun, saved, skipped, errors: rowErrors })
  return {
    ...gate,
    saved,
    skipped,
    rowErrors,
    preview: preview.length > 0 ? preview : undefined,
  }
}

function exportEntityRegistryJson(tenantId: string, entityId: string): string {
  const def = db.getEntityDefinition(tenantId, entityId, { includeRetired: true })
  if (!def) return ""
  assertEntityExportable(def)
  const config = db.getSyncDefinitionConfig(tenantId, entityId)
  const run = config ? entityRunYamlFromConfig(config) : null
  return formatEntityJson(def, run)
}

export function registerEntityRegistryRoutes(app: FastifyInstance, projectRoot?: string): void {
  app.get("/api/entity-registry/entities", async (req) => {
    const tenantId = resolveTenant(req)
    const includeRetired =
      ((req.query as Record<string, string> | undefined)?.["includeRetired"] ?? "false") === "true"
    return { tenantId, items: db.listEntityDefinitions(tenantId, { includeRetired }) }
  })

  app.get<{ Params: { id: string }; Querystring: { version?: string; includeRetired?: string } }>(
    "/api/entity-registry/entities/:id",
    async (req, reply) => {
      const tenantId = resolveTenant(req)
      const version = req.query.version ? Number(req.query.version) : undefined
      const includeRetired = req.query.includeRetired === "true"
      const def = db.getEntityDefinition(tenantId, req.params.id, { version, includeRetired })
      if (!def) {
        reply.code(404)
        return { error: `entity not found: ${req.params.id}` }
      }
      return def
    }
  )

  app.get<{ Params: { id: string } }>("/api/entity-registry/entities/:id.yaml", async (req, reply) => {
    const tenantId = resolveTenant(req)
    const def = db.getEntityDefinition(tenantId, req.params.id, { includeRetired: true })
    if (!def) {
      reply.code(404)
      return { error: `entity not found: ${req.params.id}` }
    }
    try {
      assertEntityExportable(def)
    } catch (error) {
      if (error instanceof EntityExportValidationError) {
        reply.code(409)
        return { error: error.message, entityId: error.entityId, validation: error.result }
      }
      throw error
    }
    reply.header("content-type", "application/yaml; charset=utf-8")
    const config = db.getSyncDefinitionConfig(tenantId, req.params.id)
    const run = config ? entityRunYamlFromConfig(config) : null
    return formatEntityYaml(def, run)
  })

  const sendRegistryJson = (tenantId: string, entityId: string, reply: import("fastify").FastifyReply) => {
    try {
      const body = exportEntityRegistryJson(tenantId, entityId)
      if (!body) {
        reply.code(404)
        return { error: `entity not found: ${entityId}` }
      }
      reply.header("content-type", "application/json; charset=utf-8")
      return body
    } catch (error) {
      if (error instanceof EntityExportValidationError) {
        reply.code(409)
        return { error: error.message, entityId: error.entityId, validation: error.result }
      }
      throw error
    }
  }

  app.get<{ Params: { id: string } }>("/api/entity-registry/entities/:id/registry.json", async (req, reply) => {
    const tenantId = resolveTenant(req)
    return sendRegistryJson(tenantId, req.params.id, reply)
  })

  /** @deprecated Use /entities/:id/registry.json — kept for backward compatibility. */
  app.get<{ Params: { id: string } }>("/api/entity-registry/entities/:id.json", async (req, reply) => {
    const tenantId = resolveTenant(req)
    return sendRegistryJson(tenantId, req.params.id, reply)
  })

  app.get<{ Params: { id: string } }>(
    "/api/entity-registry/entities/:id/artifact.json",
    async (req, reply) => {
      if (!projectRoot) {
        reply.code(503)
        return { error: "artifact export requires server projectRoot" }
      }
      const tenantId = resolveTenant(req)
      const def = db.getEntityDefinition(tenantId, req.params.id, { includeRetired: true })
      if (!def) {
        reply.code(404)
        return { error: `entity not found: ${req.params.id}` }
      }
      try {
        const flowTemplateCatalog = loadAuthoringFlowCatalog(projectRoot, tenantId)
        const configRow = db.getSyncDefinitionConfig(tenantId, req.params.id)
        const authored = entityToAuthoredSyncDefinition(
          def,
          flowTemplateCatalog,
          configRow ? syncConfigInputFromDb(configRow) : null,
        )
        reply.header("content-type", "application/json; charset=utf-8")
        return formatAuthoredSyncJson(authored)
      } catch (error) {
        if (error instanceof EntityExportValidationError) {
          reply.code(409)
          return { error: error.message, entityId: error.entityId, validation: error.result }
        }
        throw error
      }
    },
  )

  app.get("/api/entity-registry/entities.yaml", async (req, reply) => {
    const tenantId = resolveTenant(req)
    try {
      assertTenantEntitiesExportable(tenantId, { includeRetired: true })
    } catch (error) {
      if (error instanceof EntityExportValidationError) {
        reply.code(409)
        return { error: error.message, entityId: error.entityId, validation: error.result }
      }
      throw error
    }
    const defs = db.listEntityDefinitions(tenantId, { includeRetired: true })
    const runs = new Map(
      defs
        .map((def) => {
          const config = db.getSyncDefinitionConfig(tenantId, def.id)
          return config ? ([def.id, entityRunYamlFromConfig(config)] as const) : null
        })
        .filter((entry): entry is readonly [string, ReturnType<typeof entityRunYamlFromConfig>] => entry !== null)
    )
    reply.header("content-type", "application/yaml; charset=utf-8")
    return formatEntitiesYaml(defs, runs)
  })

  app.get<{ Params: { id: string } }>("/api/entity-registry/entities/:id/history", async (req) =>
    db.listEntityDefinitionHistory(resolveTenant(req), req.params.id)
  )

  app.get<{ Querystring: { rootTable?: string } }>(
    "/api/entity-registry/suggest-draft",
    async (req, reply): Promise<EntityRegistryDraftSuggestion | { error: string }> => {
      if (!req.session?.isAdmin) {
        reply.code(403)
        return { error: "admin only" }
      }
      const rootTable = req.query.rootTable?.trim()
      if (!rootTable) {
        reply.code(400)
        return { error: "rootTable query parameter is required" }
      }

      const catalog = loadCatalogSnapshotForSuggest()
      const flowTemplateIds = projectRoot
        ? Object.keys(loadSyncDefinitionFlowTemplateCatalog(projectRoot).flowTemplates)
        : []
      const suggestion = suggestEntityDraft(rootTable, { catalog, flowTemplateIds })
      if (!suggestion) {
        reply.code(400)
        return { error: `unable to suggest draft for root table: ${rootTable}` }
      }

      return {
        identity: {
          ...suggestion.identity,
          labelColumn: suggestion.identity.labelColumn,
          selfJoinColumn: suggestion.identity.selfJoinColumn,
        },
        tables: suggestion.tables,
        flowTemplateId: resolveFlowTemplateId(suggestion.flowTemplateId ?? undefined, projectRoot ?? ""),
        source: suggestion.source,
        notes: suggestion.notes,
      }
    },
  )

  app.get<{
    Querystring: { rootTable?: string; idColumn?: string; tableName?: string; executionOrder?: string }
  }>(
    "/api/entity-registry/suggest-table",
    async (req, reply): Promise<EntityRegistryTableSuggestion | { error: string }> => {
      if (!req.session?.isAdmin) {
        reply.code(403)
        return { error: "admin only" }
      }
      const rootTable = req.query.rootTable?.trim()
      const idColumn = req.query.idColumn?.trim()
      const tableName = req.query.tableName?.trim()
      if (!rootTable || !idColumn || !tableName) {
        reply.code(400)
        return { error: "rootTable, idColumn, and tableName query parameters are required" }
      }

      const catalog = loadCatalogSnapshotForSuggest()
      const executionOrder = req.query.executionOrder ? Number(req.query.executionOrder) : undefined
      const suggestion = suggestEntityTable(
        tableName,
        { rootTable, idColumn },
        { catalog, executionOrder: Number.isFinite(executionOrder) ? executionOrder : undefined },
      )
      if (!suggestion) {
        reply.code(400)
        return { error: `unable to suggest table for ${tableName}` }
      }

      return {
        table: suggestion.table,
        source: suggestion.source,
        note: suggestion.note,
      }
    },
  )

  app.post<{ Body: { def: EntityDefinition; reason: string; versionLabel?: string | null; createOnly?: boolean } }>(
    "/api/entity-registry/entities",
    async (req, reply) => {
      if (!req.session?.isAdmin) {
        reply.code(403)
        return { error: "admin only" }
      }
      if (!req.body?.def) {
        reply.code(400)
        return { error: "missing 'def' in body" }
      }
      if (!req.body.reason || req.body.reason.trim() === "") {
        reply.code(400)
        return { error: "'reason' is required" }
      }
      const tenantId = resolveTenant(req)
      try {
        const result = db.saveEntityDefinition({
          tenantId,
          def: req.body.def,
          actor: req.session.upn,
          reason: req.body.reason,
          versionLabel: req.body.versionLabel ?? null,
          createOnly: req.body.createOnly === true,
        })
        audit(req, "entity_registry.saved", {
          tenantId,
          id: result.id,
          version: result.version,
          reason: req.body.reason
        })
        broadcast({
          type: EventType.EntityRegistrySaved,
          data: {
            tenantId,
            id: result.id,
            version: result.version,
            actor: req.session.upn,
            diffSize: result.diff.length
          }
        })
        recordSyncCatalogChange({
          tenantId,
          reason: `entity-registry:save:${result.id}`,
          actor: req.session.upn,
        })
        return result
      } catch (error) {
        if (error instanceof db.EntityRegistryConflictError) {
          reply.code(409)
          return { error: "entity_exists", id: error.id, message: error.message }
        }
        if (error instanceof db.EntityRegistryValidationError) {
          reply.code(422)
          return { error: "validation_failed", result: error.result }
        }
        reply.code(500)
        return { error: (error as Error).message }
      }
    }
  )

  app.delete<{ Params: { id: string } }>("/api/entity-registry/entities/:id", async (req, reply) => {
    if (!req.session?.isAdmin) {
      reply.code(403)
      return { error: "admin only" }
    }
    const tenantId = resolveTenant(req)
    const result = db.retireEntityDefinition(tenantId, req.params.id, req.session.upn)
    if (!result) {
      reply.code(404)
      return { error: `entity not found: ${req.params.id}` }
    }
    audit(req, "entity_registry.retired", { tenantId, id: req.params.id })
    broadcast({
      type: EventType.EntityRegistryRetired,
      data: { tenantId, id: req.params.id, actor: req.session.upn, retiredAt: result.retiredAt }
    })
    return result
  })

  app.post<{ Body: { yaml: string; reason: string; dryRun?: boolean } }>(
    "/api/entity-registry/entities/import-yaml",
    async (req, reply): Promise<EntityRegistryYamlImportResponse | { error: string }> => {
      if (!req.session?.isAdmin) {
        reply.code(403)
        return { error: "admin only" }
      }
      if (typeof req.body?.yaml !== "string" || req.body.yaml.trim() === "") {
        reply.code(400)
        return { error: "'yaml' body is required" }
      }
      if (!req.body.reason || req.body.reason.trim() === "") {
        reply.code(400)
        return { error: "'reason' is required" }
      }
      const tenantId = resolveTenant(req)
      const dryRun = Boolean(req.body.dryRun)
      const result = importEntitiesFromText({
        tenantId,
        actor: req.session.upn,
        reason: req.body.reason,
        content: req.body.yaml,
        format: "yaml",
        dryRun,
        projectRoot
      })
      if (!dryRun) {
        audit(req, "entity_registry.imported", {
          tenantId,
          format: "yaml",
          savedCount: result.saved.length,
          errorCount: result.rowErrors.length
        })
      }
      return result
    }
  )

  app.post<{ Body: { json: string; reason: string; dryRun?: boolean } }>(
    "/api/entity-registry/entities/import-registry-json",
    async (req, reply): Promise<EntityRegistryYamlImportResponse | { error: string }> => {
      if (!req.session?.isAdmin) {
        reply.code(403)
        return { error: "admin only" }
      }
      if (typeof req.body?.json !== "string" || req.body.json.trim() === "") {
        reply.code(400)
        return { error: "'json' body is required" }
      }
      if (!req.body.reason || req.body.reason.trim() === "") {
        reply.code(400)
        return { error: "'reason' is required" }
      }
      const tenantId = resolveTenant(req)
      const dryRun = Boolean(req.body.dryRun)
      const result = importEntitiesFromText({
        tenantId,
        actor: req.session.upn,
        reason: req.body.reason,
        content: req.body.json,
        format: "json",
        dryRun,
        projectRoot,
      })
      if (!dryRun) {
        audit(req, "entity_registry.imported", {
          tenantId,
          format: "registry-json",
          savedCount: result.saved.length,
          errorCount: result.rowErrors.length,
        })
      }
      return result
    },
  )

  app.post<{ Body: { json: string; reason: string; dryRun?: boolean } }>(
    "/api/entity-registry/entities/import-artifact",
    async (req, reply): Promise<EntityRegistryYamlImportResponse | { error: string }> => {
      if (!req.session?.isAdmin) {
        reply.code(403)
        return { error: "admin only" }
      }
      if (!projectRoot) {
        reply.code(503)
        return { error: "artifact import requires server projectRoot" }
      }
      if (typeof req.body?.json !== "string" || req.body.json.trim() === "") {
        reply.code(400)
        return { error: "'json' body is required" }
      }
      if (!req.body.reason || req.body.reason.trim() === "") {
        reply.code(400)
        return { error: "'reason' is required" }
      }
      const tenantId = resolveTenant(req)
      const dryRun = Boolean(req.body.dryRun)
      const result = importAuthoredSyncFromText({
        tenantId,
        actor: req.session.upn,
        reason: req.body.reason,
        content: req.body.json,
        projectRoot,
        dryRun,
      })
      if (!dryRun) {
        audit(req, "entity_registry.imported", {
          tenantId,
          format: "artifact",
          savedCount: result.saved.length,
          errorCount: result.rowErrors.length,
        })
      }
      return result
    },
  )

  app.post<{ Body: EntityRegistryPreviewYamlRequest }>(
    "/api/entity-registry/entities/preview-yaml",
    async (req, reply): Promise<{ yaml: string } | { error: string }> => {
      if (!req.session?.isAdmin) {
        reply.code(403)
        return { error: "admin only" }
      }
      if (!req.body?.def || typeof req.body.def !== "object") {
        reply.code(400)
        return { error: "'def' body is required" }
      }
      const run = req.body.run
        ? {
            template: req.body.run.flowTemplateId,
            service: req.body.run.serviceProfileRef,
            environment: req.body.run.environmentPolicyRef,
          }
        : null
      return { yaml: formatEntityYaml(req.body.def as EntityDefinition, run) }
    },
  )

  app.post<{ Body: import("@mia/shared-types").EntityRegistryPreviewJsonRequest }>(
    "/api/entity-registry/entities/preview-json",
    async (req, reply): Promise<{ json: string } | { error: string }> => {
      if (!req.session?.isAdmin) {
        reply.code(403)
        return { error: "admin only" }
      }
      if (!req.body?.def || typeof req.body.def !== "object") {
        reply.code(400)
        return { error: "'def' body is required" }
      }
      const run = req.body.run
        ? {
            template: req.body.run.flowTemplateId,
            service: req.body.run.serviceProfileRef,
            environment: req.body.run.environmentPolicyRef,
          }
        : null
      return { json: formatEntityJson(req.body.def as EntityDefinition, run) }
    },
  )

  app.get("/api/entity-registry/strategies", async (req) => {
    const tenantId = resolveTenant(req)
    const items = db.listAvailableStrategies(tenantId)
    return { tenantId, items }
  })

  app.delete<{ Params: { id: string } }>(
    "/api/entity-registry/strategies/:id",
    async (req, reply) => {
      if (!req.session?.isAdmin) {
        reply.code(403)
        return { error: "admin only" }
      }
      const tenantId = resolveTenant(req)
      const id = req.params.id
      if (!id) {
        reply.code(400)
        return { error: "strategy id is required" }
      }
      try {
        const result = db.retireScd2Strategy(tenantId, id)
        if (!result) {
          reply.code(404)
          return {
            error: `strategy not found for tenant: ${id}. Shipped defaults cannot be deleted — fork a custom copy first.`,
          }
        }
        audit(req, "entity_registry.strategy_retired", { tenantId, id })
        broadcast({
          type: EventType.EntityRegistryStrategyRetired,
          data: { tenantId, id, actor: req.session.upn, retiredAt: result.retiredAt },
        })
        return result
      } catch (error) {
        reply.code(409)
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },
  )

  app.get<{ Params: { id: string } }>(
    "/api/entity-registry/strategies/:id/history",
    async (req) => {
      const tenantId = resolveTenant(req)
      const id = req.params.id
      if (!id) {
        return { tenantId, id: "", items: [] }
      }
      return { tenantId, id, items: db.listScd2StrategyHistory(tenantId, id) }
    }
  )

  app.post<{ Body: { strategy: Scd2Strategy; reason: string } }>(
    "/api/entity-registry/strategies",
    async (req, reply) => {
      if (!req.session?.isAdmin) {
        reply.code(403)
        return { error: "admin only" }
      }
      if (!req.body?.strategy) {
        reply.code(400)
        return { error: "missing 'strategy' in body" }
      }
      if (!req.body.reason || req.body.reason.trim() === "") {
        reply.code(400)
        return { error: "'reason' is required" }
      }
      const tenantId = resolveTenant(req)
      try {
        const result = db.saveScd2Strategy({
          tenantId,
          strategy: req.body.strategy,
          actor: req.session.upn,
          reason: req.body.reason
        })
        audit(req, "entity_registry.strategy_saved", {
          tenantId,
          id: result.id,
          version: result.version
        })
        broadcast({
          type: EventType.EntityRegistryStrategySaved,
          data: { tenantId, id: result.id, version: result.version, actor: req.session.upn }
        })
        return result
      } catch (error) {
        if (error instanceof db.EntityRegistryValidationError) {
          reply.code(422)
          return { error: "validation_failed", result: error.result }
        }
        reply.code(500)
        return { error: (error as Error).message }
      }
    }
  )
}
