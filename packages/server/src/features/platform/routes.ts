import type { FastifyInstance } from "fastify"

import type { AgentHost } from "@mia/agent"

import {
  factoryResetSyncPlatform,
  getPlatformHealth,
  rebuildPlatformCatalog,
} from "./application/platform-health-service.js"
import {
  refreshDeployArtifactsFromDatabase,
  useShippedDeployArtifacts,
} from "./application/platform-artifacts-service.js"
import {
  ensureInitialSyncCatalogVersion,
  getActiveSyncCatalogVersion,
  importSyncCatalogBundle,
  listSyncCatalogVersions,
  rollbackSyncCatalogVersion,
} from "./application/sync-catalog-versioning.js"

export interface RegisterPlatformRoutesOptions {
  projectRoot: string
  mssqlSummary: string
  bootHost: AgentHost
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

  app.post("/api/platform/catalog/rebuild", async (req, reply) => {
    if (!req.session?.isAdmin) {
      reply.code(403)
      return { ok: false, message: "Admin only" }
    }
    try {
      const result = await rebuildPlatformCatalog(opts.projectRoot, opts.bootHost)
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
        "./application/export-deploy-artifacts.js"
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
        "./application/export-deploy-artifacts.js"
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
        "../sync/application/assert-entity-export.js"
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

  app.post("/api/platform/deploy-artifacts/export/download", async (req, reply) => {
    if (!req.session?.isAdmin) {
      reply.code(403)
      return { ok: false, message: "Admin only" }
    }
    const body = (req.body ?? {}) as {
      includeRetiredEntities?: boolean
    }
    try {
      const { exportDeployGitZipBuffer } = await import(
        "./application/export-deploy-git-artifacts.js"
      )
      const { buffer, filename } = exportDeployGitZipBuffer(opts.projectRoot, {
        includeRetiredEntities: body.includeRetiredEntities,
      })
      reply
        .header("Content-Type", "application/zip")
        .header("Content-Disposition", `attachment; filename="${filename}"`)
      return reply.send(buffer)
    } catch (error) {
      const { EntityExportValidationError } = await import(
        "../sync/application/assert-entity-export.js"
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
        message: error instanceof Error ? error.message : "Deploy artifact export failed",
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

  app.post("/api/platform/deploy-artifacts/import", async (req, reply) => {
    if (!req.session?.isAdmin) {
      reply.code(403)
      return { ok: false, message: "Admin only" }
    }
    const body = (req.body ?? {}) as {
      zipBase64?: string
      dryRun?: boolean
    }
    if (!body.zipBase64) {
      reply.code(400)
      return { ok: false, message: "zipBase64 is required" }
    }
    try {
      const { parseDeployGitZipBuffer, applyDeployGitBundle } = await import(
        "./application/import-deploy-git-artifacts.js"
      )
      const buffer = Buffer.from(body.zipBase64, "base64")
      const bundle = parseDeployGitZipBuffer(buffer)
      const result = applyDeployGitBundle({
        bundle,
        actor: req.session.upn,
        projectRoot: opts.projectRoot,
        dryRun: body.dryRun,
      })
      return { ok: result.ok, preview: result }
    } catch (error) {
      reply.code(400)
      return {
        ok: false,
        message: error instanceof Error ? error.message : "Deploy artifact import failed",
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

  app.post("/api/platform/catalog/import", async (req, reply) => {
    if (!req.session?.isAdmin) {
      reply.code(403)
      return { ok: false, message: "Admin only" }
    }
    const body = (req.body ?? {}) as {
      zipBase64?: string
      snapshot?: import("./application/export-deploy-artifacts.js").DeployCatalogSnapshot
      dryRun?: boolean
      reason?: string
    }
    try {
      const result = importSyncCatalogBundle({
        zipBase64: body.zipBase64,
        snapshot: body.snapshot,
        dryRun: body.dryRun,
        reason: body.reason ?? "import",
        actor: req.session.upn,
        projectRoot: opts.projectRoot,
        host: opts.bootHost,
      })
      return { ok: result.preview.ok, ...result }
    } catch (error) {
      reply.code(400)
      return {
        ok: false,
        message: error instanceof Error ? error.message : "Catalog import failed",
      }
    }
  })

  app.post("/api/platform/catalog/rollback", async (req, reply) => {
    if (!req.session?.isAdmin) {
      reply.code(403)
      return { ok: false, message: "Admin only" }
    }
    const body = (req.body ?? {}) as { version?: number }
    if (typeof body.version !== "number" || !Number.isFinite(body.version)) {
      reply.code(400)
      return { ok: false, message: "version is required" }
    }
    try {
      const result = rollbackSyncCatalogVersion({
        targetVersion: body.version,
        actor: req.session.upn,
        projectRoot: opts.projectRoot,
        host: opts.bootHost,
      })
      return { ok: true, ...result }
    } catch (error) {
      reply.code(400)
      return {
        ok: false,
        message: error instanceof Error ? error.message : "Catalog rollback failed",
      }
    }
  })
}
