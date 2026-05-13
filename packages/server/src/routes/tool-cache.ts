/**
 * Tool-cache admin/diagnostic routes. The cache itself is keyed by sha256 of
 * (tool name + canonical input) and partitioned by the caller's session id;
 * runs share a session's cache so deterministic tool work is paid for once
 * per session, not per run.
 */

import type { FastifyInstance } from "fastify"
import { cleanupExpiredCache, clearSessionCache, getCacheStats } from "../tool-cache.js"

export function registerToolCacheRoutes(app: FastifyInstance): void {
  /** Disk-usage stats. Anyone can call this; it returns aggregate counts only. */
  app.get("/api/tool-cache/stats", async () => {
    return getCacheStats()
  })

  /** Drop expired entries across all sessions. Admin-only. */
  app.post("/api/tool-cache/cleanup", async (req, reply) => {
    if (!req.session?.isAdmin) { reply.code(403); return { error: "admin required" } }
    return cleanupExpiredCache()
  })

  /** Clear the caller's own session cache (or any session if admin). */
  app.delete<{ Querystring: { session?: string } }>("/api/tool-cache", async (req, reply) => {
    const target = req.query.session ?? req.session?.sid ?? null
    if (!target) { reply.code(400); return { error: "no session id resolvable" } }
    if (target !== req.session?.sid && !req.session?.isAdmin) {
      reply.code(403); return { error: "admin required to clear other sessions" }
    }
    return clearSessionCache(target)
  })
}
