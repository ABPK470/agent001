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
import * as db from "../db/index.js"
import type { AgentOrchestrator } from "../orchestrator/index.js"
import { listAvailableTools } from "../tools.js"

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
    }
  }>("/api/agents", async (req, reply) => {
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
    }
  }>("/api/agents/:id", async (req, reply) => {
    const existing = db.getAgentDefinition(req.params.id)
    if (!existing) {
      reply.code(404)
      return { error: "Agent not found" }
    }

    const { name, description, systemPrompt } = req.body

    // The default ("Universal") agent's system prompt is file-managed:
    // it always reflects packages/agent/prompts/default-system.md, is
    // re-synced from that file on every server startup, and the runtime
    // ignores any stored value for agentId="default". Allowing an API
    // edit here would silently disagree with both the file and the
    // runtime — refuse explicitly and direct the operator to the file.
    if (req.params.id === "default" && systemPrompt !== undefined && systemPrompt.trim() !== existing.system_prompt.trim()) {
      reply.code(400)
      return {
        error: "The default agent's system prompt is file-managed and cannot be edited via API. " +
               "Edit packages/agent/prompts/default-system.md and restart the server. " +
               "To run with a custom prompt, POST /api/agents to create a new agent.",
      }
    }

    db.saveAgentDefinition({
      ...existing,
      name: name?.trim() ?? existing.name,
      description: description !== undefined ? description.trim() : existing.description,
      system_prompt: systemPrompt?.trim() ?? existing.system_prompt,
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

    // Tool whitelisting per agent has been removed; agents always get the
    // full registry. The system prompt steers tool usage.
    //
    // resolveAgentSystemPrompt returns the file content for agentId="default"
    // (file-managed) and the stored prompt for any custom agent.
    const runId = orchestrator.startRun(goal, {
      agentId: agent.id,
      systemPrompt: db.resolveAgentSystemPrompt(agent),
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
    // Tools are not yet stored per-agent in the DB — every agent currently
    // receives the full registry at run time (resolved by the orchestrator
    // when the run starts). We still surface the effective tool list so the
    // UI's AgentDefinition contract (tools: string[]) is honoured and
    // downstream consumers (IOE map, agent panels) don't crash on
    // `undefined.length`/`for..of`.
    tools: listAvailableTools().map((t) => t.name),
    createdAt: a.created_at,
    updatedAt: a.updated_at,
  }
}
