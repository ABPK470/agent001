/**
 * Agent definition routes — CRUD for configured agents + agent-scoped runs.
 *
 * Agents are configuration, not code. Each agent definition specifies:
 *   - name + description (for humans)
 *   - system prompt (the agent's personality)
 *   - tools[] (subset of the tool registry)
 *
 * POST /api/agents/:id/runs starts a run scoped to that agent's config.
 */

import type { FastifyInstance } from "fastify"
import { randomUUID } from "node:crypto"
import * as db from "../db.js"
import type { AgentOrchestrator } from "../orchestrator.js"
import { listAvailableTools, resolveTools } from "../tools.js"

export function registerAgentRoutes(
  app: FastifyInstance,
  orchestrator: AgentOrchestrator,
): void {

  // ── Tools registry (read-only) ──────────────────────────────

  app.get("/api/tools", async () => {
    return listAvailableTools()
  })

  // ── Agent CRUD ───────────────────────────────────────────────

  app.get("/api/agents", async () => {
    return db.listAgentDefinitions().map(formatAgent)
  })

  app.get<{ Params: { id: string } }>("/api/agents/:id", async (req, reply) => {
    const agent = db.getAgentDefinition(req.params.id)
    if (!agent) {
      reply.code(404)
      return { error: "Agent not found" }
    }
    return formatAgent(agent)
  })

  app.post<{
    Body: {
      name: string
      description?: string
      systemPrompt: string
      tools: string[]
    }
  }>("/api/agents", async (req, reply) => {
    const { name, description, systemPrompt, tools } = req.body

    if (!name || typeof name !== "string" || !name.trim()) {
      reply.code(400)
      return { error: "name is required" }
    }
    if (!systemPrompt || typeof systemPrompt !== "string" || !systemPrompt.trim()) {
      reply.code(400)
      return { error: "systemPrompt is required" }
    }
    if (!Array.isArray(tools) || tools.length === 0) {
      reply.code(400)
      return { error: "tools must be a non-empty array of tool names" }
    }

    // Validate all tool names exist
    const available = new Set(listAvailableTools().map((t) => t.name))
    const unknown = tools.filter((t) => !available.has(t))
    if (unknown.length > 0) {
      reply.code(400)
      return { error: `Unknown tools: ${unknown.join(", ")}` }
    }

    const id = randomUUID()
    const now = new Date().toISOString()

    db.saveAgentDefinition({
      id,
      name: name.trim(),
      description: (description ?? "").trim(),
      system_prompt: systemPrompt.trim(),
      tools: JSON.stringify(tools),
      created_at: now,
      updated_at: now,
    })

    reply.code(201)
    return formatAgent(db.getAgentDefinition(id)!)
  })

  app.put<{
    Params: { id: string }
    Body: {
      name?: string
      description?: string
      systemPrompt?: string
      tools?: string[]
    }
  }>("/api/agents/:id", async (req, reply) => {
    const existing = db.getAgentDefinition(req.params.id)
    if (!existing) {
      reply.code(404)
      return { error: "Agent not found" }
    }

    const { name, description, systemPrompt, tools } = req.body

    if (tools !== undefined) {
      if (!Array.isArray(tools) || tools.length === 0) {
        reply.code(400)
        return { error: "tools must be a non-empty array of tool names" }
      }
      const available = new Set(listAvailableTools().map((t) => t.name))
      const unknown = tools.filter((t) => !available.has(t))
      if (unknown.length > 0) {
        reply.code(400)
        return { error: `Unknown tools: ${unknown.join(", ")}` }
      }
    }

    db.saveAgentDefinition({
      ...existing,
      name: name?.trim() ?? existing.name,
      description: description !== undefined ? description.trim() : existing.description,
      system_prompt: systemPrompt?.trim() ?? existing.system_prompt,
      tools: tools ? JSON.stringify(tools) : existing.tools,
    })

    return formatAgent(db.getAgentDefinition(req.params.id)!)
  })

  app.delete<{ Params: { id: string } }>("/api/agents/:id", async (req, reply) => {
    if (req.params.id === "default") {
      reply.code(400)
      return { error: "Cannot delete the default agent" }
    }

    const existing = db.getAgentDefinition(req.params.id)
    if (!existing) {
      reply.code(404)
      return { error: "Agent not found" }
    }

    db.deleteAgentDefinition(req.params.id)
    return { ok: true }
  })

  // ── Agent-scoped runs ────────────────────────────────────────

  app.post<{
    Params: { id: string }
    Body: { goal: string }
  }>("/api/agents/:id/runs", async (req, reply) => {
    const agent = db.getAgentDefinition(req.params.id)
    if (!agent) {
      reply.code(404)
      return { error: "Agent not found" }
    }

    const { goal } = req.body
    if (!goal || typeof goal !== "string") {
      reply.code(400)
      return { error: "goal is required" }
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
  })
}

// ── Helpers ──────────────────────────────────────────────────────

function formatAgent(a: db.DbAgentDefinition) {
  return {
    id: a.id,
    name: a.name,
    description: a.description,
    systemPrompt: a.system_prompt,
    tools: JSON.parse(a.tools) as string[],
    createdAt: a.created_at,
    updatedAt: a.updated_at,
  }
}
