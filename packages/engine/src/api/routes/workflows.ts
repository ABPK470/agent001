import type { FastifyInstance } from "fastify"
import { activateWorkflow, createWorkflow } from "../../domain/models.js"
import { getContainer } from "../container.js"
import { CreateWorkflowSchema } from "../schemas.js"

export async function workflowRoutes(app: FastifyInstance): Promise<void> {
  const c = getContainer()

  app.post("/workflows", async (req, reply) => {
    const parsed = CreateWorkflowSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() })
    }

    const wf = createWorkflow(parsed.data)
    activateWorkflow(wf)
    await c.workflowRepo.save(wf)
    await c.auditService.log({
      actor: "api",
      action: "workflow.created",
      resourceType: "workflow",
      resourceId: wf.id,
    })
    return reply.status(201).send(wf)
  })

  app.get("/workflows", async () => {
    return c.workflowRepo.listAll()
  })

  app.get<{ Params: { workflowId: string } }>(
    "/workflows/:workflowId",
    async (req, reply) => {
      const wf = await c.workflowRepo.get(req.params.workflowId)
      if (!wf) return reply.status(404).send({ error: "Workflow not found" })
      return wf
    },
  )
}
