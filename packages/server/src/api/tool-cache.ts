/**
 * Tool-cache transport routes.
 */

import type { FastifyInstance } from "fastify"
import { cleanupExpiredCache, clearSessionCache, getCacheStats } from "../adapters/persistence/tool-cache.js"

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

	app.delete<{ Querystring: { session?: string } }>("/api/tool-cache", async (req, reply) => {
		const target = req.query.session ?? req.session?.sid ?? null
		if (!target) {
			reply.code(400)
			return { error: "no session id resolvable" }
		}
		if (target !== req.session?.sid && !req.session?.isAdmin) {
			reply.code(403)
			return { error: "admin required to clear other sessions" }
		}
		return clearSessionCache(target)
	})
}