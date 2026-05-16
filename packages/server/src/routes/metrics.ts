/**
 * F1.12 — Prometheus metrics endpoint.
 *
 *   GET /metrics                                 text exposition (no auth — scrape from inside cluster)
 *
 * The text contents are derived live in `renderPrometheusMetrics()`
 * so there is no in-process counter state to drift after a restart.
 */

import type { FastifyInstance } from "fastify"
import { renderPrometheusMetrics } from "../proposer/metrics.js"

export function registerMetricsRoutes(app: FastifyInstance): void {
  app.get("/metrics", async (_req, reply) => {
    reply.header("content-type", "text/plain; version=0.0.4")
    return renderPrometheusMetrics()
  })
}
