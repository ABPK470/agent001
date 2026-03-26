import type { FastifyInstance } from "fastify"
import { ApprovalRequiredError } from "../../domain/errors.js"
import { getContainer } from "../container.js"
import { RunCreateSchema } from "../schemas.js"

export async function runRoutes(app: FastifyInstance): Promise<void> {
  const c = getContainer()

  app.post<{ Params: { workflowId: string } }>(
    "/workflows/:workflowId/runs",
    async (req, reply) => {
      const wf = await c.workflowRepo.get(req.params.workflowId)
      if (!wf) return reply.status(404).send({ error: "Workflow not found" })

      const parsed = RunCreateSchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() })
      }

      try {
        const run = await c.orchestrator.startRun(wf, parsed.data.input)
        await c.auditService.log({
          actor: "api",
          action: "run.started",
          resourceType: "run",
          resourceId: run.id,
          detail: { workflowId: wf.id },
        })
        return reply.status(201).send(run)
      } catch (err) {
        if (err instanceof ApprovalRequiredError) {
          // Run exists but is paused
          const runs = await c.runRepo.listByWorkflow(wf.id)
          const run = runs[runs.length - 1]
          return reply.status(201).send(run)
        }
        throw err
      }
    },
  )

  app.get<{ Params: { workflowId: string } }>(
    "/workflows/:workflowId/runs",
    async (req) => {
      return c.runRepo.listByWorkflow(req.params.workflowId)
    },
  )

  app.get<{ Params: { workflowId: string; runId: string } }>(
    "/workflows/:workflowId/runs/:runId",
    async (req, reply) => {
      const run = await c.runRepo.get(req.params.runId)
      if (!run || run.workflowId !== req.params.workflowId) {
        return reply.status(404).send({ error: "Run not found" })
      }
      return run
    },
  )

  app.post<{ Params: { workflowId: string; runId: string } }>(
    "/workflows/:workflowId/runs/:runId/resume",
    async (req, reply) => {
      const run = await c.runRepo.get(req.params.runId)
      if (!run || run.workflowId !== req.params.workflowId) {
        return reply.status(404).send({ error: "Run not found" })
      }

      try {
        const resumed = await c.orchestrator.resume(run)
        return resumed
      } catch (err) {
        if (err instanceof ApprovalRequiredError) {
          const updated = await c.runRepo.get(run.id)
          return updated
        }
        throw err
      }
    },
  )
}
