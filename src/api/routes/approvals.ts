import type { FastifyInstance } from "fastify"
import { getContainer } from "../container.js"
import { ApprovalResolveSchema } from "../schemas.js"

export async function approvalRoutes(app: FastifyInstance): Promise<void> {
  const c = getContainer()

  app.get<{ Querystring: { runId?: string } }>("/approvals", async (req) => {
    return c.approvalService.listPending(req.query.runId)
  })

  app.post<{ Params: { approvalId: string } }>(
    "/approvals/:approvalId/resolve",
    async (req, reply) => {
      const parsed = ApprovalResolveSchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() })
      }

      try {
        const result = await c.approvalService.resolve(
          req.params.approvalId,
          parsed.data.approved,
          parsed.data.user,
        )
        await c.auditService.log({
          actor: parsed.data.user,
          action: "approval.resolved",
          resourceType: "approval",
          resourceId: req.params.approvalId,
          detail: { approved: parsed.data.approved },
        })
        return result
      } catch (err) {
        if (err instanceof Error && err.message.includes("not found")) {
          return reply.status(404).send({ error: err.message })
        }
        throw err
      }
    },
  )
}
