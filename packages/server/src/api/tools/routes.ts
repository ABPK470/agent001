/**
 * Tool catalog transport routes.
 */

import type { FastifyInstance } from "fastify"
import { listAvailableTools } from "../../runtime/tooling/registry.js"

export function registerToolRoutes(app: FastifyInstance): void {
  app.get("/api/tools", async () => listAvailableTools())
}
