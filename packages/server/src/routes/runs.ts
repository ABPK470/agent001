/**
 * Runs API routes — manage agent runs.
 */

import type { FastifyInstance } from "fastify"
import * as db from "../db.js"
import type { AgentOrchestrator } from "../orchestrator.js"
import { resolveTools } from "../tools.js"

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
      agentId: r.agent_id ?? null,
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
      agentId: run.agent_id ?? null,
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

  // Start a new run (optionally scoped to an agent definition)
  app.post<{ Body: { goal: string; agentId?: string } }>("/api/runs", async (req, reply) => {
    const { goal, agentId } = req.body
    if (!goal || typeof goal !== "string") {
      reply.code(400)
      return { error: "goal is required" }
    }

    // If agentId provided, resolve that agent's config
    if (agentId) {
      const agent = db.getAgentDefinition(agentId)
      if (!agent) {
        reply.code(400)
        return { error: `Agent not found: ${agentId}` }
      }
      const toolNames = JSON.parse(agent.tools) as string[]
      const tools = resolveTools(toolNames)
      const runId = orchestrator.startRun(goal, {
        agentId: agent.id,
        tools,
        systemPrompt: agent.system_prompt,
      })
      reply.code(201)
      return { runId, agentId: agent.id }
    }

    // No agentId — use all tools + default prompt
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

  // Get run trace
  app.get<{ Params: { id: string } }>("/api/runs/:id/trace", async (req, reply) => {
    const run = db.getRun(req.params.id)
    if (!run) {
      reply.code(404)
      return { error: "Run not found" }
    }
    const entries = db.getTraceEntries(req.params.id)
    return entries.map((e) => JSON.parse(e.data))
  })

  // Get active runs
  app.get("/api/runs/active", async () => {
    return { runIds: orchestrator.getActiveRunIds() }
  })
}
