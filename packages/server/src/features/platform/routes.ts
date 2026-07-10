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
          "Catalog snapshot built from SQLite. Save the response locally or use the CLI to write a timestamped folder on disk.",
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

  app.post("/api/platform/artifacts/refresh", async (req, reply) => {
    if (!req.session?.isAdmin) {
      reply.code(403)
      return { ok: false, message: "Admin only" }
    }
    const body = (req.body ?? {}) as {
      source?: "shipped" | "mssql"
      connection?: string
      reseedSqlite?: boolean
    }
    const source = body.source ?? "mssql"
    try {
      const result =
        source === "shipped"
          ? useShippedDeployArtifacts(opts.projectRoot)
          : await refreshDeployArtifactsFromDatabase(opts.projectRoot, opts.bootHost, {
              connection: body.connection,
              reseedSqlite: body.reseedSqlite,
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
}
