/**
 * Thread transport routes — named conversation workspaces.
 */

import type { Run, Thread } from "@mia/shared-types"
import {
  formatThreadExportText,
  threadExportFilename,
} from "@mia/shared-types"
import type { FastifyInstance } from "fastify"
import * as db from "../../infra/persistence/sqlite.js"
import { sendUserDownload } from "../../internal/http/attachment-response.js"
import { canAccessThread } from "../auth/service/thread-access.js"
import type { AgentOrchestrator } from "../runs/orchestrator.js"

function mapRuns(rows: db.DbRunWithUsage[], orchestrator: AgentOrchestrator): Run[] {
  return rows.map((run) => {
    const diff = orchestrator.getRunWorkspaceDiff(run.id)
    const pendingWorkspaceChanges = diff
      ? diff.added.length + diff.modified.length + diff.deleted.length
      : 0
    return db.dbRunToWire(run, {
      totalTokens: run.total_tokens ?? 0,
      promptTokens: run.prompt_tokens ?? 0,
      completionTokens: run.completion_tokens ?? 0,
      llmCalls: run.llm_calls ?? 0,
      pendingWorkspaceChanges
    })
  })
}

export function registerThreadRoutes(app: FastifyInstance, orchestrator: AgentOrchestrator): void {
  app.get("/api/threads", async (req, reply) => {
    const upn = req.session?.upn
    if (!upn) {
      reply.code(401)
      return { error: "Unauthorized" }
    }
    const includeArchived = (req.query as { includeArchived?: string }).includeArchived === "1"
    const rows = db.listThreadsForUser(upn, { includeArchived })
    return rows.map((row): Thread => db.dbThreadToWire(row))
  })

  app.post<{ Body: { title?: string } }>("/api/threads", async (req, reply) => {
    const upn = req.session?.upn
    if (!upn) {
      reply.code(401)
      return { error: "Unauthorized" }
    }
    const title = typeof req.body?.title === "string" ? req.body.title : undefined
    const thread = db.createThread(upn, title)
    reply.code(201)
    return db.dbThreadToWire({ ...thread, run_count: 0 })
  })

  app.patch<{
    Params: { id: string }
    Body: { title?: string; pinned?: boolean; archived?: boolean }
  }>("/api/threads/:id", async (req, reply) => {
    const thread = db.getThread(req.params.id)
    if (!thread || !canAccessThread(req.session, thread)) {
      reply.code(404)
      return { error: "Thread not found" }
    }
    const { title, pinned, archived } = req.body ?? {}
    const updated = db.updateThread(thread.id, {
      ...(typeof title === "string" ? { title } : {}),
      ...(typeof pinned === "boolean" ? { pinned: pinned ? 1 : 0 } : {}),
      ...(typeof archived === "boolean"
        ? { archived_at: archived ? new Date().toISOString() : null }
        : {})
    })
    if (!updated) {
      reply.code(404)
      return { error: "Thread not found" }
    }
    const rows = db.listThreadsForUser(thread.upn).find((r) => r.id === thread.id)
    return db.dbThreadToWire(rows ?? { ...updated, run_count: 0 })
  })

  app.get<{ Params: { id: string } }>("/api/threads/:id/runs", async (req, reply) => {
    const thread = db.getThread(req.params.id)
    if (!thread || !canAccessThread(req.session, thread)) {
      reply.code(404)
      return { error: "Thread not found" }
    }
    return mapRuns(db.listRunsWithUsageForThread(thread.id), orchestrator)
  })

  app.delete<{ Params: { id: string } }>("/api/threads/:id", async (req, reply) => {
    const upn = req.session?.upn
    if (!upn) {
      reply.code(401)
      return { error: "Unauthorized" }
    }
    const thread = db.getThread(req.params.id)
    if (!thread || !canAccessThread(req.session, thread)) {
      reply.code(404)
      return { error: "Thread not found" }
    }
    const result = orchestrator.purgeThread(thread.id, upn)
    if (!result) {
      reply.code(404)
      return { error: "Thread not found" }
    }
    return { ok: true, deletedRuns: result.deletedRuns }
  })

  /** User download — full thread trace as .txt */
  app.get<{ Params: { id: string } }>("/api/threads/:id/export/trace", async (req, reply) => {
    const thread = db.getThread(req.params.id)
    if (!thread || !canAccessThread(req.session, thread)) {
      reply.code(404)
      return { error: "Thread not found" }
    }
    const runRows = db.listRunsWithUsageForThread(thread.id)
    const runs = runRows.map((run) => {
      const entries = db.getTraceEntries(run.id).map((entry) => JSON.parse(entry.data) as Record<string, unknown>)
      const usage = db.getTokenUsage(run.id)
      return {
        meta: {
          runId: run.id,
          goal: run.goal,
          status: run.status,
          totalTokens: usage?.total_tokens ?? null,
          llmCalls: usage?.llm_calls ?? null,
        },
        entries,
      }
    })
    const text = formatThreadExportText(runs, { threadId: thread.id, title: thread.title })
    return sendUserDownload(reply, {
      filename: threadExportFilename(thread.id, "txt"),
      contentType: "text/plain; charset=utf-8",
      body: text,
    })
  })

  /** User download — full thread trace as .json */
  app.get<{ Params: { id: string } }>("/api/threads/:id/export/trace.json", async (req, reply) => {
    const thread = db.getThread(req.params.id)
    if (!thread || !canAccessThread(req.session, thread)) {
      reply.code(404)
      return { error: "Thread not found" }
    }
    const runRows = db.listRunsWithUsageForThread(thread.id)
    const runs = runRows.map((run) => ({
      runId: run.id,
      goal: run.goal,
      status: run.status,
      createdAt: run.created_at,
      entries: db.getTraceEntries(run.id).map((entry) => JSON.parse(entry.data)),
    }))
    return sendUserDownload(reply, {
      filename: threadExportFilename(thread.id, "json"),
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify({ threadId: thread.id, title: thread.title, runs }, null, 2),
    })
  })
}
