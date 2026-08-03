import { parseBoundaryJson } from "../../internal/parse-json.js"

/**
 * Thread transport — Personal. Scope from personal.read / personal.write.
 */

import type { Run, Thread } from "@mia/shared-types"
import {
  formatThreadExportText,
  stripCodeFromTraceEntry,
  threadExportFilename,
} from "@mia/shared-types"
import type { FastifyInstance } from "fastify"
import * as db from "../../infra/persistence/sqlite.js"
import { sendUserDownload } from "../../internal/http/attachment-response.js"
import { canAccessThread } from "../auth/service/thread-access.js"
import { personal, viewingAsOf } from "../auth/service/viewing-as.js"
import type { AgentOrchestrator } from "../../runtime/orchestrator.js"

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
  app.get("/api/threads", personal.read, async (req) => {
    const { viewingAsUpn } = viewingAsOf(req)
    const includeArchived = (req.query as { includeArchived?: string }).includeArchived === "1"
    const rows = await db.listThreadsForUser(viewingAsUpn, { includeArchived })
    return rows.map((row): Thread => db.dbThreadToWire(row))
  })

  app.post<{ Body: { title?: string } }>("/api/threads", personal.write, async (req, reply) => {
    const { session } = viewingAsOf(req)
    const title = typeof req.body?.title === "string" ? req.body.title : undefined
    const thread = await db.createThread(session.upn, title)
    reply.code(201)
    return db.dbThreadToWire({ ...thread, run_count: 0 })
  })

  app.patch<{
    Params: { id: string }
    Body: { title?: string; pinned?: boolean; archived?: boolean }
  }>("/api/threads/:id", personal.write, async (req, reply) => {
    const viewingAs = viewingAsOf(req)
    const thread = await db.getThread(req.params.id)
    if (!thread || !canAccessThread(viewingAs, thread)) {
      reply.code(404)
      return { error: "Thread not found" }
    }
    const { title, pinned, archived } = req.body ?? {}
    const updated = await db.updateThread(thread.id, {
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
    const rows = (await db.listThreadsForUser(thread.upn)).find((r) => r.id === thread.id)
    return db.dbThreadToWire(rows ?? { ...updated, run_count: 0 })
  })

  app.get<{ Params: { id: string } }>("/api/threads/:id/runs", personal.read, async (req, reply) => {
    const viewingAs = viewingAsOf(req)
    const thread = await db.getThread(req.params.id)
    if (!thread || !canAccessThread(viewingAs, thread)) {
      reply.code(404)
      return { error: "Thread not found" }
    }
    return mapRuns(await db.listRunsWithUsageForThread(thread.id), orchestrator)
  })

  app.delete<{ Params: { id: string } }>("/api/threads/:id", personal.write, async (req, reply) => {
    const viewingAs = viewingAsOf(req)
    const thread = await db.getThread(req.params.id)
    if (!thread || !canAccessThread(viewingAs, thread)) {
      reply.code(404)
      return { error: "Thread not found" }
    }
    const result = await orchestrator.purgeThread(thread.id, viewingAs.session.upn)
    if (!result) {
      reply.code(404)
      return { error: "Thread not found" }
    }
    return { ok: true, deletedRuns: result.deletedRuns }
  })

  app.get<{ Params: { id: string }; Querystring: { omitCode?: string } }>(
    "/api/threads/:id/export/trace",
    personal.read,
    async (req, reply) => {
    const viewingAs = viewingAsOf(req)
    const thread = await db.getThread(req.params.id)
    if (!thread || !canAccessThread(viewingAs, thread)) {
      reply.code(404)
      return { error: "Thread not found" }
    }
    const omitCode = req.query.omitCode === "1" || req.query.omitCode === "true"
    const runRows = await db.listRunsWithUsageForThread(thread.id)
    const runs = runRows.map(async (run) => {
      const entries = (await db.getTraceEntries(run.id)).map((entry) => parseBoundaryJson(entry.data) as Record<string, unknown>)
      const usage = await db.getTokenUsage(run.id)
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
    const text = formatThreadExportText(
      await Promise.all(runs),
      { threadId: thread.id, title: thread.title },
      { omitCode },
    )
    return sendUserDownload(reply, {
      filename: threadExportFilename(thread.id, "txt", { omitCode }),
      contentType: "text/plain; charset=utf-8",
      body: text,
    })
  })

  app.get<{ Params: { id: string }; Querystring: { omitCode?: string } }>(
    "/api/threads/:id/export/trace.json",
    personal.read,
    async (req, reply) => {
    const viewingAs = viewingAsOf(req)
    const thread = await db.getThread(req.params.id)
    if (!thread || !canAccessThread(viewingAs, thread)) {
      reply.code(404)
      return { error: "Thread not found" }
    }
    const omitCode = req.query.omitCode === "1" || req.query.omitCode === "true"
    const runRows = await db.listRunsWithUsageForThread(thread.id)
    const runs = runRows.map(async (run) => ({
      runId: run.id,
      goal: run.goal,
      status: run.status,
      createdAt: run.created_at,
      entries: (await db.getTraceEntries(run.id)).map((entry) => {
        const parsed = parseBoundaryJson(entry.data) as Record<string, unknown>
        return omitCode ? stripCodeFromTraceEntry(parsed) : parsed
      }),
    }))
    return sendUserDownload(reply, {
      filename: threadExportFilename(thread.id, "json", { omitCode }),
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify(
        {
          threadId: thread.id,
          title: thread.title,
          omitCode: omitCode || undefined,
          runs: await Promise.all(runs),
        },
        null,
        2,
      ),
    })
  })
}
