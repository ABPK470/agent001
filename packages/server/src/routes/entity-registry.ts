/**
 * Entity registry routes — REST + SSE surface for the runtime entity
 * registry that replaces the static `deploy/mssql/sync-recipes.json`.
 *
 * Read endpoints:
 *   GET    /api/entity-registry/strategies                   list SCD2 strategies (tenant + inherited defaults)
 *   GET    /api/entity-registry/entities                     list entities for tenant
 *   GET    /api/entity-registry/entities/:id                 get entity (current or ?version=N)
 *   GET    /api/entity-registry/entities/:id/history         version history with structured diff
 *   GET    /api/entity-registry/entities/:id.yaml            export single entity as YAML
 *   GET    /api/entity-registry/entities.yaml                export all entities as multi-doc YAML
 *
 * Write endpoints (admin only):
 *   POST   /api/entity-registry/entities                     save (insert/new version)
 *   POST   /api/entity-registry/entities/import-yaml         bulk import YAML (with optional dry-run)
 *   POST   /api/entity-registry/strategies                   save strategy (insert/new version)
 *   DELETE /api/entity-registry/entities/:id                 retire entity
 *
 * Tenant resolution: explicit `?tenant=` query param (admin only) wins;
 * otherwise we use the sentinel `_default` tenant. This is intentionally
 * conservative until full multi-tenant identity is wired (P0.10+).
 *
 * Every successful write emits an SSE event on the shared bus so the UI
 * store can reconcile without polling.
 */

import {
    BUNDLED_SCD2_STRATEGIES,
    type EntityDefinition,
    type Scd2Strategy,
} from "@mia/agent"
import { EventType } from "@mia/shared-enums"
import type {
    EntityRegistryYamlImportResponse,
} from "@mia/shared-types"
import type { FastifyInstance, FastifyRequest } from "fastify"
import * as db from "../adapters/persistence/sqlite.js"
import { broadcast } from "../event-broadcaster.js"
import { bootstrapEntityRegistryFromYaml } from "../sync/entity-bootstrap.js"
import {
    formatEntitiesYaml,
    formatEntityYaml,
    parseEntitiesYaml,
} from "../sync/entity-yaml.js"
const DEFAULT_TENANT_ID = "_default"

function resolveTenant(req: FastifyRequest): string {
  const q = (req.query as Record<string, string> | undefined)?.["tenant"]
  if (q && req.session?.isAdmin) return q
  return DEFAULT_TENANT_ID
}

function audit(req: FastifyRequest, action: string, detail: Record<string, unknown>): void {
  try {
    db.saveAdminAudit({
      actor:     req.session.upn,
      action,
      detail:    JSON.stringify(detail),
      timestamp: new Date().toISOString(),
      scope_id:  "entity-registry",
    })
  } catch (e) {
    console.warn("[entity-registry] audit_log write failed:", e instanceof Error ? e.message : e)
  }
}

export function registerEntityRegistryRoutes(app: FastifyInstance, projectRoot?: string): void {
  // ── List entities ────────────────────────────────────────────────
  app.get("/api/entity-registry/entities", async (req) => {
    const tenantId = resolveTenant(req)
    const includeRetired = ((req.query as Record<string, string> | undefined)?.["includeRetired"] ?? "false") === "true"
    const defs = db.listEntityDefinitions(tenantId, { includeRetired })
    return { tenantId, items: defs }
  })

  // ── Get one ──────────────────────────────────────────────────────
  app.get<{ Params: { id: string }; Querystring: { version?: string; includeRetired?: string } }>(
    "/api/entity-registry/entities/:id",
    async (req, reply) => {
      const tenantId = resolveTenant(req)
      const version = req.query.version ? Number(req.query.version) : undefined
      const includeRetired = req.query.includeRetired === "true"
      const def = db.getEntityDefinition(tenantId, req.params.id, { version, includeRetired })
      if (!def) { reply.code(404); return { error: `entity not found: ${req.params.id}` } }
      return def
    },
  )

  // ── Single entity as YAML ────────────────────────────────────────
  app.get<{ Params: { id: string } }>("/api/entity-registry/entities/:id.yaml", async (req, reply) => {
    const tenantId = resolveTenant(req)
    const def = db.getEntityDefinition(tenantId, req.params.id, { includeRetired: true })
    if (!def) { reply.code(404); return { error: `entity not found: ${req.params.id}` } }
    reply.header("content-type", "application/yaml; charset=utf-8")
    return formatEntityYaml(def)
  })

  // ── All entities as multi-doc YAML ───────────────────────────────
  app.get("/api/entity-registry/entities.yaml", async (req, reply) => {
    const tenantId = resolveTenant(req)
    const defs = db.listEntityDefinitions(tenantId, { includeRetired: true })
    reply.header("content-type", "application/yaml; charset=utf-8")
    return formatEntitiesYaml(defs)
  })

  // ── History ──────────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>(
    "/api/entity-registry/entities/:id/history",
    async (req) => {
      const tenantId = resolveTenant(req)
      return db.listEntityDefinitionHistory(tenantId, req.params.id)
    },
  )

  // ── Save entity (admin) ──────────────────────────────────────────
  app.post<{ Body: { def: EntityDefinition; reason: string; versionLabel?: string | null } }>(
    "/api/entity-registry/entities",
    async (req, reply) => {
      if (!req.session?.isAdmin) { reply.code(403); return { error: "admin only" } }
      if (!req.body?.def) { reply.code(400); return { error: "missing 'def' in body" } }
      if (!req.body.reason || req.body.reason.trim() === "") {
        reply.code(400); return { error: "'reason' is required" }
      }
      const tenantId = resolveTenant(req)
      try {
        const result = db.saveEntityDefinition({
          tenantId,
          def:          req.body.def,
          actor:        req.session.upn,
          reason:       req.body.reason,
          versionLabel: req.body.versionLabel ?? null,
        })
        audit(req, "entity_registry.saved", { tenantId, id: result.id, version: result.version, reason: req.body.reason })
        broadcast({
          type: EventType.EntityRegistrySaved,
          data: { tenantId, id: result.id, version: result.version, actor: req.session.upn, diffSize: result.diff.length },
        })
        return result
      } catch (e) {
        if (e instanceof db.EntityRegistryValidationError) {
          reply.code(422); return { error: "validation_failed", result: e.result }
        }
        reply.code(500); return { error: (e as Error).message }
      }
    },
  )

  // ── Retire entity (admin) ────────────────────────────────────────
  app.delete<{ Params: { id: string } }>(
    "/api/entity-registry/entities/:id",
    async (req, reply) => {
      if (!req.session?.isAdmin) { reply.code(403); return { error: "admin only" } }
      const tenantId = resolveTenant(req)
      const result = db.retireEntityDefinition(tenantId, req.params.id, req.session.upn)
      if (!result) { reply.code(404); return { error: `entity not found: ${req.params.id}` } }
      audit(req, "entity_registry.retired", { tenantId, id: req.params.id })
      broadcast({
        type: EventType.EntityRegistryRetired,
        data: { tenantId, id: req.params.id, actor: req.session.upn, retiredAt: result.retiredAt },
      })
      return result
    },
  )

  // ── Import YAML (admin, optional dry-run) ────────────────────────
  app.post<{ Body: { yaml: string; reason: string; dryRun?: boolean } }>(
    "/api/entity-registry/entities/import-yaml",
    async (req, reply): Promise<EntityRegistryYamlImportResponse | { error: string }> => {
      if (!req.session?.isAdmin) { reply.code(403); return { error: "admin only" } }
      if (typeof req.body?.yaml !== "string" || req.body.yaml.trim() === "") {
        reply.code(400); return { error: "'yaml' body is required" }
      }
      if (!req.body.reason || req.body.reason.trim() === "") {
        reply.code(400); return { error: "'reason' is required" }
      }
      const tenantId = resolveTenant(req)
      const dryRun = Boolean(req.body.dryRun)
      const parsed = parseEntitiesYaml(req.body.yaml)

      const saved: EntityRegistryYamlImportResponse["saved"] = []
      const skipped: EntityRegistryYamlImportResponse["skipped"] = []
      const errors: EntityRegistryYamlImportResponse["errors"] = []

      for (const p of parsed) {
        if (!p.ok || !p.def) {
          errors.push({ id: null, error: p.error ?? "unknown parse error" })
          continue
        }
        const existing = db.getEntityDefinition(tenantId, p.def.id, { includeRetired: true })
        const created = existing === null

        if (dryRun) {
          saved.push({ id: p.def.id, version: existing ? existing.version + 1 : 1, created })
          continue
        }
        try {
          const result = db.saveEntityDefinition({
            tenantId,
            def:    { ...p.def, tenantId },
            actor:  req.session.upn,
            reason: req.body.reason,
          })
          saved.push({ id: result.id, version: result.version, created })
          broadcast({
            type: EventType.EntityRegistryImported,
            data: { tenantId, id: result.id, version: result.version, created, actor: req.session.upn },
          })
        } catch (e) {
          if (e instanceof db.EntityRegistryValidationError) {
            errors.push({ id: p.def.id, error: e.result })
          } else {
            errors.push({ id: p.def.id, error: (e as Error).message })
          }
        }
      }

      if (!dryRun) {
        audit(req, "entity_registry.imported", { tenantId, savedCount: saved.length, errorCount: errors.length })
      }

      return {
        ok: errors.length === 0,
        saved,
        skipped,
        errors,
        dryRun,
      }
    },
  )

  // ── Re-seed from disk (admin) ────────────────────────────────────
  // Re-runs the on-boot bootstrap importer against `deploy/mssql/entities/`.
  // Add-missing-only semantics: idempotent per-entity, never overwrites an
  // existing definition (use the import-yaml route for that). Returns the
  // exact BootstrapResult shape the boot-time seeder produces so the UI
  // can tell the operator how many entities were brought in.
  app.post("/api/entity-registry/reseed", async (req, reply) => {
    if (!req.session?.isAdmin) { reply.code(403); return { error: "admin only" } }
    if (!projectRoot) { reply.code(500); return { error: "projectRoot not configured" } }
    try {
      const result = bootstrapEntityRegistryFromYaml(projectRoot)
      audit(req, "entity_registry.reseeded", {
        imported: result.imported,
        skipped:  result.skipped,
        errors:   result.errors.length,
      })
      if (result.imported > 0) {
        broadcast({
          type: EventType.EntityRegistryImported,
          data: { tenantId: DEFAULT_TENANT_ID, actor: req.session.upn, imported: result.imported, source: "reseed" },
        })
      }
      return result
    } catch (e) {
      reply.code(500); return { error: (e as Error).message }
    }
  })

  // ── List strategies ──────────────────────────────────────────────
  app.get("/api/entity-registry/strategies", async (req) => {
    const tenantId = resolveTenant(req)
    const stored = db.listAvailableStrategies(tenantId)
    // Bundled fallback: also surface bundled strategies that haven't been
    // persisted into _default yet (defensive — seeder should have placed
    // them, but the UI should still render in fresh-install edge cases).
    const seen = new Set(stored.map((s) => s.id))
    const bundled = BUNDLED_SCD2_STRATEGIES.filter((s) => !seen.has(s.id))
    return { tenantId, items: [...stored, ...bundled] }
  })

  // ── Save strategy (admin) ────────────────────────────────────────
  app.post<{ Body: { strategy: Scd2Strategy; reason: string } }>(
    "/api/entity-registry/strategies",
    async (req, reply) => {
      if (!req.session?.isAdmin) { reply.code(403); return { error: "admin only" } }
      if (!req.body?.strategy) { reply.code(400); return { error: "missing 'strategy' in body" } }
      if (!req.body.reason || req.body.reason.trim() === "") {
        reply.code(400); return { error: "'reason' is required" }
      }
      const tenantId = resolveTenant(req)
      try {
        const result = db.saveScd2Strategy({
          tenantId,
          strategy: req.body.strategy,
          actor:    req.session.upn,
          reason:   req.body.reason,
        })
        audit(req, "entity_registry.strategy_saved", { tenantId, id: result.id, version: result.version })
        broadcast({
          type: EventType.EntityRegistryStrategySaved,
          data: { tenantId, id: result.id, version: result.version, actor: req.session.upn },
        })
        return result
      } catch (e) {
        if (e instanceof db.EntityRegistryValidationError) {
          reply.code(422); return { error: "validation_failed", result: e.result }
        }
        reply.code(500); return { error: (e as Error).message }
      }
    },
  )
}
