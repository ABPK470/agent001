/**
 * Memory, Trajectory & Effects API routes.
 */

import type { FastifyInstance } from "fastify"
import {
    getEffectStats,
    getFileHistory,
    getRunEffects,
    getRunSnapshots,
    rollbackRun,
} from "../effects.js"
import {
    clearAllMemories,
    consolidate,
    getMemoryStats,
    listMemories,
    prune,
    retrieveContext,
    searchMemories,
    searchProcedures,
    type MemoryTier,
} from "../memory.js"
import type { AgentOrchestrator } from "../orchestrator.js"
import {
    compareTrajectories,
    loadTrajectory,
    replay,
    summarizeTrajectory,
    type Mutation,
} from "../trajectory.js"

export function registerMemoryRoutes(
  app: FastifyInstance,
  _orchestrator: AgentOrchestrator,
): void {
  // ── Memory ───────────────────────────────────────────────────

  /** Search memories (FTS5). */
  app.post<{ Body: { query: string; tier?: MemoryTier; maxItems?: number } }>(
    "/api/memory/search",
    async (req, reply) => {
      const { query, tier, maxItems } = req.body
      if (!query || typeof query !== "string") {
        reply.code(400)
        return { error: "query is required" }
      }
      const results = searchMemories(query, {
        tier,
        budget: maxItems ? { maxTokens: 8000, maxItems } : undefined,
      })
      return results.map((r) => ({
        id: r.memory.id,
        tier: r.memory.tier,
        content: r.memory.content,
        metadata: r.memory.metadata,
        source: r.memory.source,
        confidence: r.memory.confidence,
        accessCount: r.memory.accessCount,
        rank: r.rank,
        score: r.score,
        createdAt: r.memory.createdAt,
      }))
    },
  )

  /** List memories by tier. */
  app.get<{ Querystring: { tier?: MemoryTier; limit?: string } }>(
    "/api/memory",
    async (req) => {
      const tier = req.query.tier
      const limit = req.query.limit ? parseInt(req.query.limit, 10) : 50
      const memories = listMemories(tier, limit)
      return memories.map((m) => ({
        id: m.id,
        tier: m.tier,
        content: m.content,
        metadata: m.metadata,
        source: m.source,
        confidence: m.confidence,
        accessCount: m.accessCount,
        createdAt: m.createdAt,
      }))
    },
  )

  /** Memory statistics. */
  app.get("/api/memory/stats", async () => {
    return getMemoryStats()
  })

  /** Preview memory context for a goal (what would be injected). */
  app.post<{ Body: { goal: string } }>(
    "/api/memory/preview",
    async (req, reply) => {
      const { goal } = req.body
      if (!goal || typeof goal !== "string") {
        reply.code(400)
        return { error: "goal is required" }
      }
      const { context, results } = retrieveContext(goal)
      return {
        context,
        resultCount: results.length,
        results: results.map((r) => ({
          tier: r.entry.tier,
          role: r.entry.role,
          content: r.entry.content.slice(0, 200),
          confidence: r.entry.confidence,
          relevance: r.relevance,
          recency: r.recency,
          combined: r.combined,
        })),
      }
    },
  )

  /** Search procedural memories by goal. */
  app.post<{ Body: { goal: string; limit?: number } }>(
    "/api/memory/procedures",
    async (req, reply) => {
      const { goal, limit } = req.body
      if (!goal || typeof goal !== "string") {
        reply.code(400)
        return { error: "goal is required" }
      }
      const procedures = searchProcedures(goal, limit ?? 5)
      return procedures.map((p) => ({
        id: p.id,
        trigger: p.trigger,
        toolSequence: p.toolSequence,
        successCount: p.successCount,
        failureCount: p.failureCount,
        createdAt: p.createdAt,
      }))
    },
  )

  /** Consolidate episodic → semantic. */
  app.post("/api/memory/consolidate", async () => {
    return consolidate()
  })

  /** Prune expired / low-confidence memories. */
  app.post("/api/memory/prune", async () => {
    return prune()
  })

  /** Clear all memories. */
  app.delete("/api/memory", async () => {
    clearAllMemories()
    return { ok: true }
  })

  // ── Trajectory ───────────────────────────────────────────────

  /** Get full trajectory for a run. */
  app.get<{ Params: { runId: string } }>(
    "/api/trajectory/:runId",
    async (req) => {
      const trajectory = loadTrajectory(req.params.runId)
      return trajectory
    },
  )

  /** Get human-readable trajectory summary. */
  app.get<{ Params: { runId: string } }>(
    "/api/trajectory/:runId/summary",
    async (req) => {
      const summary = summarizeTrajectory(req.params.runId)
      return { summary }
    },
  )

  /** Replay a trajectory with optional mutations. */
  app.post<{ Params: { runId: string }; Body: { mutations?: Mutation[] } }>(
    "/api/trajectory/:runId/replay",
    async (req) => {
      const result = replay(req.params.runId, req.body.mutations)
      return {
        valid: result.valid,
        violations: result.violations,
        scorecard: result.scorecard,
        eventCount: result.trajectory.events.length,
      }
    },
  )

  /** Compare two trajectories. */
  app.post<{ Body: { runIdA: string; runIdB: string } }>(
    "/api/trajectory/compare",
    async (req, reply) => {
      const { runIdA, runIdB } = req.body
      if (!runIdA || !runIdB) {
        reply.code(400)
        return { error: "runIdA and runIdB are required" }
      }
      return compareTrajectories(runIdA, runIdB)
    },
  )

  // ── Effects ──────────────────────────────────────────────────

  /** Get all effects for a run. */
  app.get<{ Params: { runId: string } }>(
    "/api/effects/:runId",
    async (req) => {
      const effects = getRunEffects(req.params.runId)
      return effects.map((e) => ({
        id: e.id,
        seq: e.seq,
        kind: e.kind,
        tool: e.tool,
        target: e.target,
        preHash: e.preHash,
        postHash: e.postHash,
        status: e.status,
        metadata: e.metadata,
        createdAt: e.createdAt,
      }))
    },
  )

  /** Get effect statistics for a run. */
  app.get<{ Params: { runId: string } }>(
    "/api/effects/:runId/stats",
    async (req) => {
      return getEffectStats(req.params.runId)
    },
  )

  /** Get file snapshots for a run. */
  app.get<{ Params: { runId: string } }>(
    "/api/effects/:runId/snapshots",
    async (req) => {
      const snapshots = getRunSnapshots(req.params.runId)
      return snapshots.map((s) => ({
        id: s.id,
        effectId: s.effectId,
        filePath: s.filePath,
        hasContent: s.content !== null,
        hash: s.hash,
        createdAt: s.createdAt,
      }))
    },
  )

  /** Get file modification history across all runs. */
  app.post<{ Body: { filePath: string } }>(
    "/api/effects/file-history",
    async (req, reply) => {
      const { filePath } = req.body
      if (!filePath || typeof filePath !== "string") {
        reply.code(400)
        return { error: "filePath is required" }
      }
      const history = getFileHistory(filePath)
      return history.map((e) => ({
        id: e.id,
        runId: e.runId,
        kind: e.kind,
        tool: e.tool,
        status: e.status,
        preHash: e.preHash,
        postHash: e.postHash,
        createdAt: e.createdAt,
      }))
    },
  )

  /** Rollback all file effects for a run. */
  app.post<{ Params: { runId: string } }>(
    "/api/effects/:runId/rollback",
    async (req) => {
      const result = await rollbackRun(req.params.runId)
      return result
    },
  )
}
