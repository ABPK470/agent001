import type { FastifyInstance } from "fastify"

import type { AgentHost } from "@mia/agent"

import { buildAboutDossier } from "./service/about-service.js"
import {
  factoryResetSyncPlatform,
  getPlatformHealth,
  rebuildPlatformCatalog,
} from "./service/platform-health-service.js"
import { resetFactoryPolicyDefaults } from "../policies/service/policy-seeder.js"
import {
  refreshDeployArtifactsFromDatabase,
  useShippedDeployArtifacts,
} from "./service/platform-artifacts-service.js"
import {
  getActiveSyncCatalogVersion,
  getSyncCatalogVersionDetail,
  getSyncCatalogVersionDiff,
  importSyncCatalogBundle,
  listSyncCatalogVersions,
  rollbackSyncCatalogVersion,
} from "./service/sync-catalog-versioning.js"

export interface RegisterPlatformRoutesOptions {
  projectRoot: string
  mssqlSummary: string
  bootHost: AgentHost
  getWorkspacePath?: () => string
  getActiveRunCount?: () => number
  getQueuePending?: () => number
}

export function registerPlatformRoutes(app: FastifyInstance, opts: RegisterPlatformRoutesOptions): void {
  app.get("/api/platform/health", async (_req, reply) => {
    try {
      return getPlatformHealth(opts.projectRoot, opts.mssqlSummary, opts.bootHost)
    } catch (error) {
      reply.code(500)
      return {
        ok: false,
        message: error instanceof Error ? error.message : "Failed to read platform health",
      }
    }
  })

  /** Documentary About dossier — available to every authenticated session. */
  app.get("/api/about", async (req, reply) => {
    const session = req.session
    if (!session?.upn) {
      reply.code(401)
      return { error: "not authenticated" }
    }
    try {
      return buildAboutDossier({
        projectRoot: opts.projectRoot,
        mssqlSummary: opts.mssqlSummary,
        bootHost: opts.bootHost,
        workspacePath: opts.getWorkspacePath?.() ?? "",
        activeRuns: opts.getActiveRunCount?.() ?? 0,
        queuePending: opts.getQueuePending?.() ?? 0,
        viewer: {
          upn: session.upn,
          displayName: session.displayName ?? session.upn,
          isAdmin: Boolean(session.isAdmin),
        },
      })
    } catch (error) {
      reply.code(500)
      return {
        error: error instanceof Error ? error.message : "Failed to build about dossier",
      }
    }
  })

  app.post("/api/platform/catalog/rebuild", async (req, reply) => {
    if (!req.session?.isAdmin) {
      reply.code(403)
      return { ok: false, message: "Admin only" }
    }
    try {
      const result = await rebuildPlatformCatalog(opts.bootHost)
      reply.code(result.ok ? 200 : 400)
      return result
    } catch (error) {
      reply.code(500)
      return {
        ok: false,
        message: error instanceof Error ? error.message : "Catalog rebuild failed",
      }
    }
  })

  app.post("/api/platform/factory-reset", async (req, reply) => {
    if (!req.session?.isAdmin) {
      reply.code(403)
      return { ok: false, message: "Admin only" }
    }
    const body = (req.body ?? {}) as { confirm?: string }
    if (body.confirm !== "FACTORY RESET") {
      reply.code(400)
      return { ok: false, message: 'Type confirm: "FACTORY RESET"' }
    }
    try {
      const result = factoryResetSyncPlatform(opts.projectRoot)
      return {
        ok: true,
        message:
          result.seeded > 0
            ? `Re-seeded ${result.seeded} entity definition(s) from deploy artifacts. Publish from Entity Registry when ready.`
            : "Entity registry cleared. Add or import entities, then publish from Entity Registry.",
        seeded: result.seeded,
        entityIds: result.entityIds,
      }
    } catch (error) {
      reply.code(500)
      return {
        ok: false,
        message: error instanceof Error ? error.message : "Factory reset failed",
      }
    }
  })

  /**
   * Re-read deploy/policies/defaults.json and replace factory-named policy rows.
   * Never runs on boot — admin must confirm explicitly.
   */
  app.post("/api/platform/policies/reset-defaults", async (req, reply) => {
    if (!req.session?.isAdmin) {
      reply.code(403)
      return { ok: false, message: "Admin only" }
    }
    const body = (req.body ?? {}) as { confirm?: string }
    if (body.confirm !== "RESET POLICY DEFAULTS") {
      reply.code(400)
      return { ok: false, message: 'Type confirm: "RESET POLICY DEFAULTS"' }
    }
    try {
      const result = resetFactoryPolicyDefaults(opts.projectRoot)
      return {
        ok: true,
        message: `Restored ${result.inserted} factory policy rule(s) from ${result.seedPath} (removed ${result.removed} prior factory/edited factory-named row(s)). Operator rules with other names were preserved.`,
        ...result,
      }
    } catch (error) {
      reply.code(500)
      return {
        ok: false,
        message: error instanceof Error ? error.message : "Policy defaults reset failed",
      }
    }
  })

  app.post("/api/platform/artifacts/export", async (req, reply) => {
    if (!req.session?.isAdmin) {
      reply.code(403)
      return { ok: false, message: "Admin only" }
    }
    const body = (req.body ?? {}) as {
      includeRetiredEntities?: boolean
    }
    try {
      const { buildDeployCatalogSnapshot } = await import(
        "./service/export-deploy-artifacts.js"
      )
      const snapshot = buildDeployCatalogSnapshot({
        includeRetiredEntities: body.includeRetiredEntities,
      })
      return {
        ok: true,
        message:
          "Catalog snapshot built from SQLite. Use /api/platform/artifacts/export/download for mia-sync-export zip.",
        snapshot,
      }
    } catch (error) {
      reply.code(500)
      return {
        ok: false,
        message: error instanceof Error ? error.message : "Artifact export failed",
      }
    }
  })

  app.post("/api/platform/artifacts/export/download", async (req, reply) => {
    if (!req.session?.isAdmin) {
      reply.code(403)
      return { ok: false, message: "Admin only" }
    }
    const body = (req.body ?? {}) as {
      includeRetiredEntities?: boolean
    }
    try {
      const { exportDeployCatalogZipBuffer } = await import(
        "./service/export-deploy-artifacts.js"
      )
      const { buffer, filename } = exportDeployCatalogZipBuffer({
        includeRetiredEntities: body.includeRetiredEntities,
      })
      reply
        .header("Content-Type", "application/zip")
        .header("Content-Disposition", `attachment; filename="${filename}"`)
      return reply.send(buffer)
    } catch (error) {
      const { EntityExportValidationError } = await import(
        "../sync/service/assert-entity-export.js"
      )
      if (error instanceof EntityExportValidationError) {
        reply.code(409)
        return {
          ok: false,
          message: error.message,
          entityId: error.entityId,
          validation: error.result,
        }
      }
      reply.code(500)
      return {
        ok: false,
        message: error instanceof Error ? error.message : "Artifact export failed",
      }
    }
  })

  app.post("/api/platform/artifacts/refresh", async (req, reply) => {
    if (!req.session?.isAdmin) {
      reply.code(403)
      return { ok: false, message: "Admin only" }
    }
    const body = (req.body ?? {}) as {
      source?: "shipped" | "mssql"
      connection?: string
      reseedSqlite?: boolean
      writeArtifacts?: boolean
    }
    const source = body.source ?? "mssql"
    const actor = req.session.upn
    try {
      const result =
        source === "shipped"
          ? useShippedDeployArtifacts(opts.projectRoot, actor)
          : await refreshDeployArtifactsFromDatabase(opts.projectRoot, opts.bootHost, {
              connection: body.connection,
              reseedSqlite: body.reseedSqlite,
              writeArtifacts: body.writeArtifacts,
              actor,
            })
      reply.code(result.ok ? 200 : 400)
      return result
    } catch (error) {
      reply.code(500)
      return {
        ok: false,
        message: error instanceof Error ? error.message : "Artifact refresh failed",
        source,
      }
    }
  })

  app.get("/api/platform/catalog/versions", async (req, reply) => {
    if (!req.session?.isAdmin) {
      reply.code(403)
      return { ok: false, message: "Admin only" }
    }
    const activeVersion = getActiveSyncCatalogVersion()
    const versions = listSyncCatalogVersions()
    return { ok: true, activeVersion, versions }
  })

  app.get<{ Params: { version: string } }>(
    "/api/platform/catalog/versions/:version",
    async (req, reply) => {
      if (!req.session?.isAdmin) {
        reply.code(403)
        return { ok: false, message: "Admin only" }
      }
      const version = Number(req.params.version)
      if (!Number.isFinite(version)) {
        reply.code(400)
        return { ok: false, message: "version must be a number" }
      }
      const detail = getSyncCatalogVersionDetail(version)
      if (!detail) {
        reply.code(404)
        return { ok: false, message: `Unknown catalog version ${version}` }
      }
      return { ok: true, detail }
    },
  )

  app.get<{ Params: { version: string }; Querystring: { against?: string } }>(
    "/api/platform/catalog/versions/:version/diff",
    async (req, reply) => {
      if (!req.session?.isAdmin) {
        reply.code(403)
        return { ok: false, message: "Admin only" }
      }
      const version = Number(req.params.version)
      if (!Number.isFinite(version)) {
        reply.code(400)
        return { ok: false, message: "version must be a number" }
      }
      const rawAgainst = req.query.against?.trim() || "previous"
      let against: "previous" | "active" | number = "previous"
      if (rawAgainst === "previous" || rawAgainst === "active") {
        against = rawAgainst
      } else {
        const asNumber = Number(rawAgainst)
        if (!Number.isFinite(asNumber)) {
          reply.code(400)
          return { ok: false, message: "against must be previous, active, or a version number" }
        }
        against = asNumber
      }
      const diff = getSyncCatalogVersionDiff({ version, against })
      if (!diff) {
        reply.code(404)
        return { ok: false, message: `Unknown catalog version ${version}` }
      }
      return { ok: true, diff }
    },
  )

  app.post("/api/platform/catalog/import", async (req, reply) => {
    if (!req.session?.isAdmin) {
      reply.code(403)
      return { ok: false, message: "Admin only" }
    }
    const body = (req.body ?? {}) as {
      zipBase64?: string
      snapshot?: import("./service/export-deploy-artifacts.js").DeployCatalogSnapshot
      dryRun?: boolean
      reason?: string
    }
    const dryRun = Boolean(body.dryRun)
    const { assertCanApply, catalogPreviewToGate } = await import("./service/import-gate.js")
    if (!dryRun) {
      const blocked = assertCanApply({ dryRun: false, reason: body.reason, ok: true })
      if (blocked) {
        return catalogPreviewToGate({
          ok: false,
          dryRun: false,
          applied: false,
          errors: [blocked],
          counts: {},
        })
      }
    }
    try {
      const result = importSyncCatalogBundle({
        zipBase64: body.zipBase64,
        snapshot: body.snapshot,
        dryRun,
        reason: body.reason ?? "import",
        actor: req.session.upn,
        projectRoot: opts.projectRoot,
        host: opts.bootHost,
      })
      return catalogPreviewToGate({
        ok: result.preview.ok,
        dryRun: result.preview.dryRun,
        applied: result.preview.applied,
        errors: result.preview.errors,
        counts: result.preview.counts,
        version: result.version ? { version: result.version.version } : undefined,
        warnings: dryRun ? [] : [`reason: ${String(body.reason ?? "").trim()}`],
      })
    } catch (error) {
      return catalogPreviewToGate({
        ok: false,
        dryRun,
        applied: false,
        errors: [error instanceof Error ? error.message : "Catalog import failed"],
        counts: {},
      })
    }
  })

  app.post("/api/platform/catalog/rollback", async (req, reply) => {
    if (!req.session?.isAdmin) {
      reply.code(403)
      return { ok: false, message: "Admin only" }
    }
    const body = (req.body ?? {}) as { version?: number; dryRun?: boolean; reason?: string }
    if (typeof body.version !== "number" || !Number.isFinite(body.version)) {
      reply.code(400)
      return { ok: false, message: "version is required" }
    }
    const dryRun = Boolean(body.dryRun)
    const { assertCanApply, catalogPreviewToGate, emptyImpact } = await import("./service/import-gate.js")
    if (!dryRun) {
      const blocked = assertCanApply({ dryRun: false, reason: body.reason, ok: true })
      if (blocked) {
        return catalogPreviewToGate({
          ok: false,
          dryRun: false,
          applied: false,
          errors: [blocked],
          counts: {},
        })
      }
    }
    try {
      if (dryRun) {
        const { getSyncCatalogVersionRow } = await import("../../infra/persistence/sqlite.js")
        const row = getSyncCatalogVersionRow("_default", body.version)
        if (!row) {
          return catalogPreviewToGate({
            ok: false,
            dryRun: true,
            applied: false,
            errors: [`Unknown catalog version ${body.version}`],
            counts: {},
          })
        }
        const snapshot = JSON.parse(row.snapshot_json) as {
          entityIds?: string[]
          environments?: { environments?: unknown[] }
        }
        const entityIds = Array.isArray(snapshot.entityIds) ? snapshot.entityIds : []
        const envCount = Array.isArray(snapshot.environments?.environments)
          ? snapshot.environments.environments.length
          : 0
        const impact = emptyImpact()
        impact.updates.push(...entityIds)
        return catalogPreviewToGate({
          ok: true,
          dryRun: true,
          applied: false,
          errors: [],
          counts: { entities: entityIds.length, environments: envCount },
          impact,
          warnings: [
            `Restoring catalog version ${body.version} will replace the live sync catalog (entities, environments, strategies, metadata).`,
          ],
        })
      }

      const result = rollbackSyncCatalogVersion({
        targetVersion: body.version,
        actor: req.session.upn,
        projectRoot: opts.projectRoot,
        host: opts.bootHost,
      })
      return catalogPreviewToGate({
        ok: result.importResult.ok,
        dryRun: false,
        applied: result.importResult.applied,
        errors: result.importResult.errors,
        counts: result.importResult.counts,
        version: { version: result.version.version },
        warnings: [`reason: ${String(body.reason ?? "").trim()}`, `rolled back from version ${body.version}`],
      })
    } catch (error) {
      return catalogPreviewToGate({
        ok: false,
        dryRun,
        applied: false,
        errors: [error instanceof Error ? error.message : "Catalog rollback failed"],
        counts: {},
      })
    }
  })
}
