/**
 * Runs API routes — manage agent runs.
 */

import type { FastifyInstance } from "fastify"
import * as db from "../db.js"
import type { AgentOrchestrator } from "../orchestrator.js"

export function registerRunRoutes(
  app: FastifyInstance,
  orchestrator: AgentOrchestrator,
): void {

  // List all runs
  app.get("/api/runs", async () => {
    const runs = db.listRuns()
    return runs.map((r) => ({
      id: r.id,
      goal: r.goal,
      status: r.status,
      answer: r.answer,
      stepCount: r.step_count,
      error: r.error,
      parentRunId: r.parent_run_id,
      createdAt: r.created_at,
      completedAt: r.completed_at,
    }))
  })

  // Get run details
  app.get<{ Params: { id: string } }>("/api/runs/:id", async (req, reply) => {
    const run = db.getRun(req.params.id)
    if (!run) {
      reply.code(404)
      return { error: "Run not found" }
    }

    const audit = db.getAuditLog(run.id)
    const logs = db.getLogs(run.id)
    const checkpoint = db.getCheckpoint(run.id)

    return {
      id: run.id,
      goal: run.goal,
      status: run.status,
      answer: run.answer,
      stepCount: run.step_count,
      error: run.error,
      parentRunId: run.parent_run_id,
      data: JSON.parse(run.data),
      createdAt: run.created_at,
      completedAt: run.completed_at,
      audit: audit.map((a) => ({
        actor: a.actor,
        action: a.action,
        detail: JSON.parse(a.detail),
        timestamp: a.timestamp,
      })),
      logs: logs.map((l) => ({
        level: l.level,
        message: l.message,
        timestamp: l.timestamp,
      })),
      hasCheckpoint: !!checkpoint,
    }
  })

  // Start a new run
  app.post<{ Body: { goal: string } }>("/api/runs", async (req, reply) => {
    const { goal } = req.body
    if (!goal || typeof goal !== "string") {
      reply.code(400)
      return { error: "goal is required" }
    }

    const runId = orchestrator.startRun(goal)
    reply.code(201)
    return { runId }
  })

  // Cancel a run
  app.post<{ Params: { id: string } }>("/api/runs/:id/cancel", async (req, reply) => {
    const ok = orchestrator.cancelRun(req.params.id)
    if (!ok) {
      reply.code(404)
      return { error: "Run not found or not active" }
    }
    return { ok: true }
  })

  // Resume a failed run
  app.post<{ Params: { id: string } }>("/api/runs/:id/resume", async (req, reply) => {
    const newRunId = orchestrator.resumeRun(req.params.id)
    if (!newRunId) {
      reply.code(404)
      return { error: "Run not found or no checkpoint available" }
    }
    reply.code(201)
    return { runId: newRunId }
  })

  // Get active runs
  app.get("/api/runs/active", async () => {
    return { runIds: orchestrator.getActiveRunIds() }
  })
}
