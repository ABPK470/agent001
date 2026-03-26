import Fastify from "fastify"
import { actionRoutes } from "./routes/actions.js"
import { approvalRoutes } from "./routes/approvals.js"
import { runRoutes } from "./routes/runs.js"
import { workflowRoutes } from "./routes/workflows.js"

export function createApp() {
  const app = Fastify({ logger: true })

  app.get("/health", async () => ({ status: "ok" }))

  app.register(workflowRoutes)
  app.register(runRoutes)
  app.register(approvalRoutes)
  app.register(actionRoutes)

  return app
}
