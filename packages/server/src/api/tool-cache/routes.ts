/**
 * Tool-cache transport routes.
 */

import type { FastifyInstance } from "fastify"
import { cleanupExpiredCache, clearUserCache, getCacheStats } from "../../infra/persistence/tool-cache.js"

export function registerToolCacheRoutes(app: FastifyInstance): void {
  app.get("/api/tool-cache/stats", async () => {
    return getCacheStats()
  })

  app.post("/api/tool-cache/cleanup", async (req, reply) => {
    if (!req.session?.isAdmin) {
      reply.code(403)
      return { error: "admin required" }
    }
    return cleanupExpiredCache()
  })

  app.delete<{ Querystring: { upn?: string } }>("/api/tool-cache", async (req, reply) => {
    const target = req.query.upn ?? req.session?.upn ?? null
    if (!target) {
      reply.code(400)
      return { error: "no upn resolvable" }
    }
    if (target.toLowerCase() !== req.session?.upn?.toLowerCase() && !req.session?.isAdmin) {
      reply.code(403)
      return { error: "admin required to clear other users' cache" }
    }
    return clearUserCache(target)
  })
}
