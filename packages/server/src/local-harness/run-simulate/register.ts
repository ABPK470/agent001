/**
 * Registers POST /api/runs/simulate only when MIA_LOCAL_RUN_SIMULATE=1.
 * Not a product route — local laptop harness only.
 */

import type { FastifyInstance } from "fastify"
import * as db from "../../infra/persistence/sqlite.js"
import { canAccessThread } from "../../api/auth/service/thread-access.js"
import { personal, viewingAsOf } from "../../api/auth/service/viewing-as.js"
import { isLocalRunSimulateEnabled } from "./allow.js"
import { isDemoRunPace, isDemoRunScenarioId } from "./demo-run-scenarios.js"
import { startSimulatedLiveRun } from "./simulate-live-run.js"

export function registerLocalRunSimulateHarness(app: FastifyInstance): void {
  if (!isLocalRunSimulateEnabled()) return

  app.post<{
    Body: { scenario?: string; pace?: string; threadId?: string }
  }>("/api/runs/simulate", personal.write, async (req, reply) => {
    const session = req.session
    if (!session?.upn) {
      reply.code(401)
      return { error: "Authentication required" }
    }
    const scenario = req.body?.scenario
    if (!isDemoRunScenarioId(scenario)) {
      reply.code(400)
      return { error: "scenario must be direct | planner-seq | planner-parallel" }
    }
    const pace = req.body?.pace
    if (pace != null && !isDemoRunPace(pace)) {
      reply.code(400)
      return { error: "pace must be fast | normal | slow" }
    }
    const threadId =
      typeof req.body?.threadId === "string" && req.body.threadId.trim()
        ? req.body.threadId.trim()
        : undefined
    if (threadId) {
      const thread = await db.getThread(threadId)
      if (!thread || !canAccessThread(viewingAsOf(req), thread)) {
        reply.code(404)
        return { error: "Thread not found" }
      }
    }
    const result = await startSimulatedLiveRun({
      scenario,
      pace: isDemoRunPace(pace) ? pace : "normal",
      threadId,
      upn: session.upn,
      displayName: session.displayName ?? null,
    })
    reply.code(201)
    return result
  })
}
