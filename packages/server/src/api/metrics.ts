/**
 * Prometheus metrics transport route.
 */

import type { FastifyInstance } from "fastify"
import { renderPrometheusMetrics } from "../proposer/metrics.js"

export function registerMetricsRoutes(app: FastifyInstance): void {
	app.get("/metrics", async (_req, reply) => {
		reply.header("content-type", "text/plain; version=0.0.4")
		return renderPrometheusMetrics()
	})
}