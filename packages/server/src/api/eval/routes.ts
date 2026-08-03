/**
 * Evaluation dataset — capture golden steps from trace inspector.
 */

import type { FastifyInstance } from "fastify"
import * as db from "../../infra/persistence/sqlite.js"
import { canAccessRun } from "../auth/service/access.js"
import { canAccessThread } from "../auth/service/thread-access.js"
import { personal, viewingAsOf } from "../auth/service/viewing-as.js"

type AddEvalBody = {
  runId: string
  threadId?: string | null
  scopeId: string
  kind: string
  callIndex?: number | null
  label?: string | null
  input: unknown
  output?: unknown
  metadata?: Record<string, unknown>
}

export function registerEvalRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: { runId?: string; threadId?: string; limit?: string } }>(
    "/api/eval/dataset",
    personal.read,
    async (req, reply) => {
      const viewingAs = viewingAsOf(req)
      const { runId, threadId } = req.query
      const limit = Math.min(Number(req.query.limit) || 200, 500)

      if (runId) {
        const run = await db.getRun(runId)
        if (!run || !canAccessRun(viewingAs, run)) {
          reply.code(404)
          return { error: "Run not found" }
        }
      }
      if (threadId) {
        const thread = await db.getThread(threadId)
        if (!thread || !canAccessThread(viewingAs, thread)) {
          reply.code(404)
          return { error: "Thread not found" }
        }
      }

      const rows = await db.listEvalDatasetEntries({ runId, threadId, limit })
      return { entries: rows.map(db.evalEntryToWire) }
    },
  )

  app.post<{ Body: AddEvalBody }>("/api/eval/dataset", personal.write, async (req, reply) => {
    const viewingAs = viewingAsOf(req)
    const body = req.body as AddEvalBody
    const run = await db.getRun(body.runId)
    if (!run || !canAccessRun(viewingAs, run)) {
      reply.code(404)
      return { error: "Run not found" }
    }
    if (body.threadId) {
      const thread = await db.getThread(body.threadId)
      if (!thread || !canAccessThread(viewingAs, thread)) {
        reply.code(404)
        return { error: "Thread not found" }
      }
    }

    const row = await db.insertEvalDatasetEntry({
      threadId: body.threadId ?? run.thread_id,
      runId: body.runId,
      scopeId: body.scopeId,
      kind: body.kind,
      callIndex: body.callIndex,
      label: body.label,
      input: body.input,
      output: body.output,
      metadata: body.metadata,
      createdBy: viewingAs.viewingAsUpn,
    })
    reply.code(201)
    return db.evalEntryToWire(row)
  })

  app.get<{ Params: { id: string } }>("/api/eval/dataset/:id", personal.read, async (req, reply) => {
    const row = await db.getEvalDatasetEntry(req.params.id)
    if (!row) {
      reply.code(404)
      return { error: "Entry not found" }
    }
    const run = await db.getRun(row.run_id)
    const viewingAs = viewingAsOf(req)
    if (!run || !canAccessRun(viewingAs, run)) {
      reply.code(404)
      return { error: "Entry not found" }
    }
    return db.evalEntryToWire(row)
  })

  app.delete<{ Params: { id: string } }>(
    "/api/eval/dataset/:id",
    personal.write,
    async (req, reply) => {
      const row = await db.getEvalDatasetEntry(req.params.id)
      if (!row) {
        reply.code(404)
        return { error: "Entry not found" }
      }
      const run = await db.getRun(row.run_id)
      const viewingAs = viewingAsOf(req)
      if (!run || !canAccessRun(viewingAs, run)) {
        reply.code(404)
        return { error: "Entry not found" }
      }
      await db.deleteEvalDatasetEntry(req.params.id)
      reply.code(204)
      return null
    },
  )
}
