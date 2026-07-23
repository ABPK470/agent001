/**
 * Memory and effects transport routes.
 */

import type { FastifyInstance } from "fastify"
import {
  getEffectStats,
  getFileHistory,
  getRunEffects,
  getRunSnapshots,
  previewRollback,
  rollbackRun
} from "../../infra/effects/index.js"
import {
  clearAllMemories,
  consolidate,
  getMemoryStats,
  listMemories,
  prune,
  retrieveContext,
  searchEntries,
  type MemoryTier
} from "../../infra/persistence/memory.js"
import type { AgentOrchestrator } from "../../runtime/orchestrator.js"

export function registerMemoryRoutes(app: FastifyInstance, _orchestrator: AgentOrchestrator): void {
  const tenantScope = (req: { session: { isAdmin: boolean; upn: string } }): string | undefined =>
    req.session.isAdmin ? undefined : req.session.upn

  app.post<{ Body: { query: string; tier?: MemoryTier; maxItems?: number } }>(
    "/api/memory/search",
    async (req, reply) => {
      const { query, tier, maxItems } = req.body
      if (!query || typeof query !== "string") {
        reply.code(400)
        return { error: "query is required" }
      }
      const limit = maxItems ?? 20
      const results = await searchEntries(query, {
        tier,
        budget: { maxTokens: 8000, maxItems: limit },
        upn: tenantScope(req)
      })
      return results.map((result) => ({
        id: result.entry.id,
        tier: result.entry.tier,
        content: result.entry.content,
        metadata: result.entry.metadata,
        source: result.entry.source,
        confidence: result.entry.confidence,
        accessCount: result.entry.accessCount,
        rank: result.relevance,
        score: result.combined,
        createdAt: result.entry.createdAt
      }))
    }
  )

  app.get<{ Querystring: { tier?: MemoryTier; limit?: string } }>("/api/memory", async (req) => {
    const tier = req.query.tier
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 50
    const memories = listMemories(tier, limit, { upn: tenantScope(req) })
    return memories.map((memory) => ({
      id: memory.id,
      tier: memory.tier,
      content: memory.content,
      metadata: memory.metadata,
      source: memory.source,
      confidence: memory.confidence,
      accessCount: memory.accessCount,
      createdAt: memory.createdAt
    }))
  })

  app.get("/api/memory/stats", async (req) => getMemoryStats({ upn: tenantScope(req) }))

  app.post<{ Body: { goal: string } }>("/api/memory/preview", async (req, reply) => {
    const { goal } = req.body
    if (!goal || typeof goal !== "string") {
      reply.code(400)
      return { error: "goal is required" }
    }
    const { context, results } = await retrieveContext(goal, {
      upn: tenantScope(req)
    })
    return {
      context,
      resultCount: results.length,
      results: results.map((result) => ({
        tier: result.entry.tier,
        role: result.entry.role,
        content: result.entry.content.slice(0, 200),
        confidence: result.entry.confidence,
        relevance: result.relevance,
        recency: result.recency,
        combined: result.combined
      }))
    }
  })

  app.post("/api/memory/consolidate", async (req, reply) => {
    if (!req.session?.isAdmin) {
      reply.code(403)
      return { error: "admin required" }
    }
    return consolidate()
  })

  app.post("/api/memory/prune", async (req, reply) => {
    if (!req.session?.isAdmin) {
      reply.code(403)
      return { error: "admin required" }
    }
    return prune()
  })

  app.delete("/api/memory", async (req, reply) => {
    if (!req.session?.isAdmin) {
      reply.code(403)
      return { error: "admin required" }
    }
    clearAllMemories()
    return { ok: true }
  })

  app.get<{ Params: { runId: string } }>("/api/effects/:runId", async (req) =>
    getRunEffects(req.params.runId).map((effect) => ({
      id: effect.id,
      seq: effect.seq,
      kind: effect.kind,
      tool: effect.tool,
      target: effect.target,
      preHash: effect.preHash,
      postHash: effect.postHash,
      status: effect.status,
      metadata: effect.metadata,
      createdAt: effect.createdAt
    }))
  )
  app.get<{ Params: { runId: string } }>("/api/effects/:runId/stats", async (req) =>
    getEffectStats(req.params.runId)
  )
  app.get<{ Params: { runId: string } }>("/api/effects/:runId/snapshots", async (req) =>
    getRunSnapshots(req.params.runId).map((snapshot) => ({
      id: snapshot.id,
      effectId: snapshot.effectId,
      filePath: snapshot.filePath,
      hasContent: snapshot.content !== null,
      hash: snapshot.hash,
      createdAt: snapshot.createdAt
    }))
  )
  app.post<{ Body: { filePath: string } }>("/api/effects/file-history", async (req, reply) => {
    const { filePath } = req.body
    if (!filePath || typeof filePath !== "string") {
      reply.code(400)
      return { error: "filePath is required" }
    }
    return getFileHistory(filePath).map((effect) => ({
      id: effect.id,
      runId: effect.runId,
      kind: effect.kind,
      tool: effect.tool,
      status: effect.status,
      preHash: effect.preHash,
      postHash: effect.postHash,
      createdAt: effect.createdAt
    }))
  })
  app.get<{ Params: { runId: string } }>("/api/effects/:runId/rollback-preview", async (req) =>
    previewRollback(req.params.runId)
  )
  app.post<{ Params: { runId: string } }>("/api/effects/:runId/rollback", async (req) =>
    rollbackRun(req.params.runId)
  )
}
