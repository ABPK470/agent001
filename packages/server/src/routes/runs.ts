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

  // List all runs (with token usage)
  app.get("/api/runs", async () => {
    const runs = db.listRunsWithUsage()
    return runs.map((r) => ({
      pendingWorkspaceChanges: (() => {
        const diff = orchestrator.getRunWorkspaceDiff(r.id)
        return diff ? diff.added.length + diff.modified.length + diff.deleted.length : 0
      })(),
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
      totalTokens: r.total_tokens ?? 0,
      promptTokens: r.prompt_tokens ?? 0,
      completionTokens: r.completion_tokens ?? 0,
      llmCalls: r.llm_calls ?? 0,
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
    const usage = db.getTokenUsage(run.id)
    const pendingDiff = orchestrator.getRunWorkspaceDiff(run.id)
    const pendingWorkspaceChanges = pendingDiff
      ? pendingDiff.added.length + pendingDiff.modified.length + pendingDiff.deleted.length
      : 0

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
      totalTokens: usage?.total_tokens ?? 0,
      promptTokens: usage?.prompt_tokens ?? 0,
      completionTokens: usage?.completion_tokens ?? 0,
      llmCalls: usage?.llm_calls ?? 0,
      pendingWorkspaceChanges,
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

  // Re-run: start a fresh run with the same goal and agent as a previous run
  app.post<{ Params: { id: string } }>("/api/runs/:id/rerun", async (req, reply) => {
    const original = db.getRun(req.params.id)
    if (!original) {
      reply.code(404)
      return { error: "Run not found" }
    }

    if (original.agent_id) {
      const agent = db.getAgentDefinition(original.agent_id)
      if (!agent) {
        reply.code(400)
        return { error: `Agent definition not found: ${original.agent_id}` }
      }
      const toolNames = JSON.parse(agent.tools) as string[]
      const tools = resolveTools(toolNames)
      const runId = orchestrator.startRun(original.goal, {
        agentId: agent.id,
        tools,
        systemPrompt: agent.system_prompt,
      })
      reply.code(201)
      return { runId, agentId: agent.id }
    }

    const runId = orchestrator.startRun(original.goal)
    reply.code(201)
    return { runId }
  })

  // Respond to a pending ask_user request
  app.post<{ Params: { id: string }; Body: { response: string } }>("/api/runs/:id/respond", async (req, reply) => {
    const { response } = req.body
    if (!response && response !== "") {
      reply.code(400)
      return { error: "response is required" }
    }
    const ok = orchestrator.respondToRun(req.params.id, String(response))
    if (!ok) {
      reply.code(404)
      return { error: "No pending input request for this run" }
    }
    return { ok: true }
  })

  // Kill a specific tool call and provide a user steering message
  app.post<{ Params: { id: string }; Body: { toolCallId: string; message: string } }>("/api/runs/:id/kill-tool", async (req, reply) => {
    const { toolCallId, message } = req.body
    if (!toolCallId) {
      reply.code(400)
      return { error: "toolCallId is required" }
    }
    const ok = orchestrator.killToolCall(req.params.id, String(toolCallId), String(message ?? ""))
    if (!ok) {
      reply.code(404)
      return { error: "No executing tool call with that ID" }
    }
    return { ok: true }
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

  // Get isolated workspace diff for a completed run
  app.get<{ Params: { id: string } }>("/api/runs/:id/workspace-diff", async (req, reply) => {
    const run = db.getRun(req.params.id)
    if (!run) {
      reply.code(404)
      return { error: "Run not found" }
    }

    const diff = orchestrator.getRunWorkspaceDiff(req.params.id)
    if (!diff) {
      reply.code(404)
      return { error: "No isolated workspace diff available for this run" }
    }

    return {
      runId: req.params.id,
      added: diff.added,
      modified: diff.modified,
      deleted: diff.deleted,
      total: diff.added.length + diff.modified.length + diff.deleted.length,
    }
  })

  // Apply approved isolated workspace diff back to source workspace
  app.post<{ Params: { id: string } }>("/api/runs/:id/workspace-diff/apply", async (req, reply) => {
    const run = db.getRun(req.params.id)
    if (!run) {
      reply.code(404)
      return { error: "Run not found" }
    }

    const applied = await orchestrator.applyRunWorkspaceDiff(req.params.id)
    if (!applied) {
      reply.code(404)
      return { error: "No pending isolated workspace diff to apply" }
    }

    return {
      ok: true,
      runId: req.params.id,
      applied,
    }
  })

  // Get active runs
  app.get("/api/runs/active", async () => {
    return { runIds: orchestrator.getActiveRunIds() }
  })

  // Queue stats
  app.get("/api/queue", async () => {
    return orchestrator.getQueueStats()
  })
}
