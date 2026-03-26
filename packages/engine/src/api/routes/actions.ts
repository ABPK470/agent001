import type { FastifyInstance } from "fastify"
import { getContainer } from "../container.js"

export async function actionRoutes(app: FastifyInstance): Promise<void> {
  const c = getContainer()

  /** List all registered action handler names. */
  app.get("/actions", async () => {
    return { actions: c.actionRegistry.listNames() }
  })
}
