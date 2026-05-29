/**
 * Layout transport routes.
 */

import type { FastifyInstance } from "fastify"
import { randomUUID } from "node:crypto"
import * as db from "../adapters/persistence/sqlite.js"

function dashboardIdFor(req: { session: { upn: string } }): string {
	return `dashboard:${req.session.upn.toLowerCase()}`
}

export function registerLayoutRoutes(app: FastifyInstance): void {
	app.get("/api/dashboard-state", async (req) => {
		const state = db.getLayout(dashboardIdFor(req))
		return state ? JSON.parse(state.config) : null
	})

	app.put<{ Body: { views: unknown; activeViewId: string } }>("/api/dashboard-state", async (req) => {
		db.saveLayout({
			id: dashboardIdFor(req),
			name: `Dashboard for ${req.session.displayName}`,
			config: JSON.stringify({
				views: req.body.views,
				activeViewId: req.body.activeViewId,
			}),
			updated_at: new Date().toISOString(),
		})
		return { ok: true }
	})

	app.get("/api/layouts", async () => {
		const layouts = db.getLayouts()
		return layouts.map((layout) => ({
			id: layout.id,
			name: layout.name,
			config: JSON.parse(layout.config),
			updatedAt: layout.updated_at,
		}))
	})

	app.post<{ Body: { name: string; config: unknown } }>("/api/layouts", async (req, reply) => {
		const { name, config } = req.body
		if (!name || !config) {
			reply.code(400)
			return { error: "name and config are required" }
		}

		const id = randomUUID()
		db.saveLayout({
			id,
			name: String(name),
			config: JSON.stringify(config),
			updated_at: new Date().toISOString(),
		})

		reply.code(201)
		return { id }
	})

	app.put<{ Params: { id: string }; Body: { name?: string; config?: unknown } }>("/api/layouts/:id", async (req, reply) => {
		const existing = db.getLayout(req.params.id)
		if (!existing) {
			reply.code(404)
			return { error: "Layout not found" }
		}

		db.saveLayout({
			id: req.params.id,
			name: req.body.name ? String(req.body.name) : existing.name,
			config: req.body.config ? JSON.stringify(req.body.config) : existing.config,
			updated_at: new Date().toISOString(),
		})

		return { ok: true }
	})

	app.delete<{ Params: { id: string } }>("/api/layouts/:id", async (req) => {
		db.deleteLayout(req.params.id)
		return { ok: true }
	})
}
