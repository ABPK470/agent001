/**
 * Trace utilities — isolated step replay for inspector playground.
 */

import type { FastifyInstance } from "fastify"
import * as db from "../../infra/persistence/sqlite.js"
import { canAccessRun } from "../auth/service/access.js"
import { personal, viewingAsOf } from "../auth/service/viewing-as.js"
import type { AgentOrchestrator } from "../../runtime/orchestrator.js"
import { replayTraceStep, type TraceReplayStepRequest } from "./replay-step.js"

export function registerTraceRoutes(app: FastifyInstance, orchestrator: AgentOrchestrator): void {
  app.post<{
    Params: { runId: string }
    Body: TraceReplayStepRequest
  }>("/api/runs/:runId/trace/replay-step", personal.write, async (req, reply) => {
    const viewingAs = viewingAsOf(req)
    const run = db.getRun(req.params.runId)
    if (!run || !canAccessRun(viewingAs, run)) {
      reply.code(404)
      return { error: "Run not found" }
    }

    const body = req.body as TraceReplayStepRequest
    try {
      const result = await replayTraceStep(orchestrator.getLlm(), body)
      return result
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Replay failed"
      reply.code(400)
      return { error: message }
    }
  })
}
