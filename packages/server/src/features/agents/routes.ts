/**
 * Agent definition transport routes.
 */

import type { FastifyInstance } from "fastify"
import { randomUUID } from "node:crypto"
import * as db from "../../platform/persistence/sqlite.js"
import type { AgentOrchestrator } from "../runs/orchestrator.js"
import { listAvailableTools } from "../runs/tooling/registry.js"

export function registerAgentRoutes(app: FastifyInstance, orchestrator: AgentOrchestrator): void {
  app.get("/api/tools", async () => listAvailableTools())

  app.get("/api/agents", async () => db.listAgentDefinitions().map(formatAgent))

  app.get<{ Params: { id: string } }>("/api/agents/:id", async (req, reply) => {
    const agent = db.getAgentDefinition(req.params.id)
    if (!agent) {
      reply.code(404)
      return { error: "Agent not found" }
    }
    return formatAgent(agent)
  })

  app.post<{ Body: { name: string; description?: string; systemPrompt: string } }>(
    "/api/agents",
    async (req, reply) => {
      const { name, description, systemPrompt } = req.body
      if (!name || typeof name !== "string" || !name.trim()) {
        reply.code(400)
        return { error: "name is required" }
      }
      if (!systemPrompt || typeof systemPrompt !== "string" || !systemPrompt.trim()) {
        reply.code(400)
        return { error: "systemPrompt is required" }
      }
      const id = randomUUID()
      const now = new Date().toISOString()
      db.saveAgentDefinition({
        id,
        name: name.trim(),
        description: (description ?? "").trim(),
        system_prompt: systemPrompt.trim(),
        created_at: now,
        updated_at: now
      })
      reply.code(201)
      return formatAgent(db.getAgentDefinition(id)!)
    }
  )

  app.put<{ Params: { id: string }; Body: { name?: string; description?: string; systemPrompt?: string } }>(
    "/api/agents/:id",
    async (req, reply) => {
      const existing = db.getAgentDefinition(req.params.id)
      if (!existing) {
        reply.code(404)
        return { error: "Agent not found" }
      }

      const { name, description, systemPrompt } = req.body
      if (
        req.params.id === "default" &&
        systemPrompt !== undefined &&
        systemPrompt.trim() !== existing.system_prompt.trim()
      ) {
        reply.code(400)
        return {
          error:
            "The default agent's system prompt is file-managed and cannot be edited via API. " +
            "Edit packages/agent/prompts/default-system.md and restart the server. " +
            "To run with a custom prompt, POST /api/agents to create a new agent."
        }
      }

      db.saveAgentDefinition({
        ...existing,
        name: name?.trim() ?? existing.name,
        description: description !== undefined ? description.trim() : existing.description,
        system_prompt: systemPrompt?.trim() ?? existing.system_prompt
      })

      return formatAgent(db.getAgentDefinition(req.params.id)!)
    }
  )

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

  app.post<{ Params: { id: string }; Body: { goal: string } }>("/api/agents/:id/runs", async (req, reply) => {
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

    const runId = orchestrator.startRun(
      goal,
      {
        agentId: agent.id,
        systemPrompt: db.resolveAgentSystemPrompt(agent)
      },
      req.session ?? null
    )

    reply.code(201)
    return { runId, agentId: agent.id }
  })
}

function formatAgent(agent: db.DbAgentDefinition) {
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    systemPrompt: agent.system_prompt,
    tools: listAvailableTools().map((tool) => tool.name),
    createdAt: agent.created_at,
    updatedAt: agent.updated_at
  }
}
