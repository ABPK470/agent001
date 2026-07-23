/**
 * Run transport routes.
 */

import { EventType } from "@mia/agent"
import type { AuditEntry, LogEntry, Run, RunDetail, TableExportRequest } from "@mia/shared-types"
import {
  formatTraceExportText,
  resolveTablesForExport,
  serializeAnswerTableCsv,
  serializeAnswerTablesJson,
  tableExportFilename,
  traceExportFilename,
} from "@mia/shared-types"
import type { FastifyInstance } from "fastify"
import { runHasCompensatableEffects } from "../../infra/effects/index.js"
import { getAttachment, type AttachmentRow } from "../../infra/persistence/attachments.js"
import { flagRunMemory } from "../../infra/persistence/memory.js"
import * as db from "../../infra/persistence/sqlite.js"
import { sendUserDownload } from "../../internal/http/attachment-response.js"
import { MemoryValidationAction } from "../../internal/enums/memory.js"
import { AuthRequiredError, canAccessRun, requireSessionUpn } from "../auth/service/access.js"
import { ContinuityError } from "../runs/continuity.js"
import type { AgentOrchestrator } from "../runs/orchestrator.js"
import { listRunArtifactFiles, openRunArtifactStream } from "./run-artifacts.js"

function withRunCapabilities(run: Run): Run {
  return {
    ...run,
    hasCheckpoint: !!db.getCheckpoint(run.id),
    rollbackAvailable: runHasCompensatableEffects(run.id),
  }
}

export function registerRunRoutes(app: FastifyInstance, orchestrator: AgentOrchestrator): void {
  app.get<{ Querystring: { threadId?: string } }>("/api/runs", async (req, reply) => {
    try {
      requireSessionUpn(req.session)
    } catch {
      reply.code(401)
      return { error: "Authentication required" }
    }
    const s = req.session!
    const threadId = req.query.threadId
    if (threadId) {
      const thread = db.getThread(threadId)
      if (!thread || !s?.upn || thread.upn.toLowerCase() !== s.upn.toLowerCase()) {
        reply.code(404)
        return { error: "Thread not found" }
      }
      const runs = db.listRunsWithUsageForThread(threadId)
      return runs.map((run): Run => {
        const diff = orchestrator.getRunWorkspaceDiff(run.id)
        const pendingWorkspaceChanges = diff
          ? diff.added.length + diff.modified.length + diff.deleted.length
          : 0
        return withRunCapabilities(db.dbRunToWire(run, {
          totalTokens: run.total_tokens ?? 0,
          promptTokens: run.prompt_tokens ?? 0,
          completionTokens: run.completion_tokens ?? 0,
          llmCalls: run.llm_calls ?? 0,
          pendingWorkspaceChanges
        }))
      })
    }
    const runs = db.listRunsWithUsageForUser({ upn: s.upn })
    return runs.map((run): Run => {
      const diff = orchestrator.getRunWorkspaceDiff(run.id)
      const pendingWorkspaceChanges = diff
        ? diff.added.length + diff.modified.length + diff.deleted.length
        : 0
      return withRunCapabilities(db.dbRunToWire(run, {
        totalTokens: run.total_tokens ?? 0,
        promptTokens: run.prompt_tokens ?? 0,
        completionTokens: run.completion_tokens ?? 0,
        llmCalls: run.llm_calls ?? 0,
        pendingWorkspaceChanges
      }))
    })
  })

  app.get<{ Params: { id: string } }>("/api/runs/:id", async (req, reply) => {
    const run = db.getRun(req.params.id)
    if (!run) {
      reply.code(404)
      return { error: "Run not found" }
    }
    if (!canAccessRun(req.session, run)) {
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
      ...withRunCapabilities(db.dbRunToWire(run, {
        totalTokens: usage?.total_tokens ?? 0,
        promptTokens: usage?.prompt_tokens ?? 0,
        completionTokens: usage?.completion_tokens ?? 0,
        llmCalls: usage?.llm_calls ?? 0,
        pendingWorkspaceChanges
      })),
      audit: audit.map(
        (entry): AuditEntry => ({
          actor: entry.actor,
          action: entry.action,
          detail: JSON.parse(entry.detail),
          timestamp: entry.timestamp
        })
      ),
      logs: logs.map((entry): LogEntry => {
        const isOldFormat = entry.level === "info" || entry.level === "error"
        if (isOldFormat) {
          const colonIdx = entry.message.indexOf(": ")
          const rawType = colonIdx > 0 ? entry.message.slice(0, colonIdx) : entry.level
          const typeGroup =
            rawType.startsWith("step.") || rawType.startsWith("tool_call.")
              ? "step"
              : rawType.startsWith("run.")
                ? "run"
                : "system"
          let msg = entry.message
          let error: boolean | undefined
          try {
            const payload = JSON.parse(entry.message.slice(colonIdx + 2)) as Record<string, unknown>
            const action = (payload.action ?? payload.name ?? "unknown") as string
            switch (rawType) {
              case EventType.RunStarted:
                msg = `Started — run ${((payload.runId as string) ?? "?").slice(0, 8)}`
                break
              case EventType.StepStarted:
                msg = `${action} started`
                break
              case EventType.StepCompleted:
                msg = `${action} completed`
                break
              case EventType.StepFailed:
                msg = `${action} failed — ${((payload.error as string) ?? "unknown").slice(0, 200)}`
                error = true
                break
              default:
                msg = rawType.replace(/^[^.]+\./, "")
            }
          } catch (err: unknown) { console.error("[mia]", err) }
          if (entry.level === "error") error = true
          return {
            type: typeGroup,
            message: msg,
            timestamp: entry.timestamp,
            ...(error ? { error } : {})
          }
        }
        const hasError = entry.level.endsWith(":error")
        const type = hasError ? entry.level.slice(0, -6) : entry.level
        return {
          type,
          message: entry.message,
          timestamp: entry.timestamp,
          ...(hasError ? { error: true } : {})
        }
      }),
      hasCheckpoint: !!checkpoint
    } satisfies RunDetail
  })

  app.post<{ Body: { goal: string; attachmentIds?: string[]; threadId?: string } }>(
    "/api/runs",
    async (req, reply) => {
      try {
        requireSessionUpn(req.session)
      } catch {
        reply.code(401)
        return { error: "Authentication required" }
      }
      const { goal, attachmentIds, threadId } = req.body
      if (!goal || typeof goal !== "string") {
        reply.code(400)
        return { error: "goal is required" }
      }

      const resolvedAttachmentIds: string[] = []
      if (Array.isArray(attachmentIds) && attachmentIds.length > 0) {
        const session = req.session!
        const seen = new Set<string>()
        for (const id of attachmentIds) {
          if (typeof id !== "string" || seen.has(id)) continue
          seen.add(id)
          const row: AttachmentRow | undefined = getAttachment(id)
          if (!row) {
            reply.code(400)
            return { error: `attachment not found: ${id}` }
          }
          const allowed =
            session.isAdmin || (row.owner_upn && row.owner_upn === session.upn)
          if (!allowed) {
            reply.code(403)
            return { error: `attachment not accessible: ${id}` }
          }
          resolvedAttachmentIds.push(id)
        }
      }

      try {
        const runId = orchestrator.startRun(
          goal,
          { attachmentIds: resolvedAttachmentIds, threadId },
          req.session!
        )
        reply.code(201)
        return { runId, attachmentIds: resolvedAttachmentIds }
      } catch (err) {
        if (err instanceof AuthRequiredError) {
          reply.code(401)
          return { error: err.message }
        }
        if (err instanceof ContinuityError) {
          reply.code(400)
          return { error: err.message }
        }
        throw err
      }
    }
  )

  app.post<{ Params: { id: string } }>("/api/runs/:id/cancel", async (req, reply) => {
    const run = db.getRun(req.params.id)
    if (!run || !canAccessRun(req.session, run)) {
      reply.code(404)
      return { error: "Run not found" }
    }
    const ok = orchestrator.cancelRun(req.params.id)
    if (!ok) {
      reply.code(404)
      return { error: "Run not found or not active" }
    }
    return { ok: true }
  })

  app.post<{ Params: { id: string } }>("/api/runs/:id/resume", async (req, reply) => {
    const run = db.getRun(req.params.id)
    if (!run || !canAccessRun(req.session, run)) {
      reply.code(404)
      return { error: "Run not found" }
    }
    const newRunId = orchestrator.resumeRun(req.params.id, req.session ?? null)
    if (!newRunId) {
      reply.code(404)
      return { error: "Run not found or no checkpoint available" }
    }
    reply.code(201)
    return { runId: newRunId }
  })

  app.get("/api/runs/tool-approvals/pending", async (req, reply) => {
    try {
      const { listPendingToolApprovalsForSession } = await import(
        "./service/run-tool-approval.js"
      )
      return listPendingToolApprovalsForSession(req.session ?? null)
    } catch (error) {
      reply.code(error instanceof Error && error.message.includes("Authentication") ? 401 : 400)
      return { error: error instanceof Error ? error.message : "Failed to list pending approvals" }
    }
  })

  app.post<{ Params: { id: string } }>(
    "/api/runs/tool-approvals/:id/approve",
    async (req, reply) => {
      try {
        const { approveRunToolStep } = await import("./service/run-tool-approval.js")
        return approveRunToolStep(orchestrator, req.params.id, req.session ?? null)
      } catch (error) {
        reply.code(error instanceof Error && error.message.includes("Authentication") ? 401 : 400)
        return { error: error instanceof Error ? error.message : "Approval failed" }
      }
    }
  )

  app.post<{ Params: { id: string }; Body: { reason?: string } }>(
    "/api/runs/tool-approvals/:id/deny",
    async (req, reply) => {
      try {
        const { denyRunToolStep } = await import("./service/run-tool-approval.js")
        return denyRunToolStep(
          orchestrator,
          req.params.id,
          req.session ?? null,
          req.body?.reason
        )
      } catch (error) {
        reply.code(error instanceof Error && error.message.includes("Authentication") ? 401 : 400)
        return { error: error instanceof Error ? error.message : "Deny failed" }
      }
    }
  )

  app.post<{ Params: { id: string } }>("/api/runs/:id/rerun", async (req, reply) => {
    const original = db.getRun(req.params.id)
    if (!original || !canAccessRun(req.session, original)) {
      reply.code(404)
      return { error: "Run not found" }
    }
    const runId = orchestrator.startRun(
      original.goal,
      { threadId: original.thread_id ?? undefined },
      req.session ?? null
    )
    reply.code(201)
    return { runId }
  })

  app.post<{ Params: { id: string }; Body: { response: string } }>(
    "/api/runs/:id/respond",
    async (req, reply) => {
      const run = db.getRun(req.params.id)
      if (!run || !canAccessRun(req.session, run)) {
        reply.code(404)
        return { error: "Run not found" }
      }
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
    }
  )

  app.post<{ Params: { id: string }; Body: { toolCallId: string; message: string } }>(
    "/api/runs/:id/kill-tool",
    async (req, reply) => {
      const run = db.getRun(req.params.id)
      if (!run || !canAccessRun(req.session, run)) {
        reply.code(404)
        return { error: "Run not found" }
      }
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
    }
  )

  app.get<{ Params: { id: string } }>("/api/runs/:id/trace", async (req, reply) => {
    const run = db.getRun(req.params.id)
    if (!run || !canAccessRun(req.session, run)) {
      reply.code(404)
      return { error: "Run not found" }
    }
    return db.getTraceEntries(req.params.id).map((entry) => JSON.parse(entry.data))
  })

  /** User download — trace as .txt (streamed to browser, not saved on server). */
  app.get<{ Params: { id: string } }>("/api/runs/:id/export/trace", async (req, reply) => {
    const run = db.getRun(req.params.id)
    if (!run || !canAccessRun(req.session, run)) {
      reply.code(404)
      return { error: "Run not found" }
    }
    const entries = db.getTraceEntries(req.params.id).map((entry) => JSON.parse(entry.data) as Record<string, unknown>)
    const usage = db.getTokenUsage(req.params.id)
    const text = formatTraceExportText(entries, {
      runId: req.params.id,
      goal: run.goal,
      status: run.status,
      totalTokens: usage?.total_tokens ?? null,
      llmCalls: usage?.llm_calls ?? null,
    })
    return sendUserDownload(reply, {
      filename: traceExportFilename(req.params.id, "txt"),
      contentType: "text/plain; charset=utf-8",
      body: text,
    })
  })

  /** User download — trace as .json */
  app.get<{ Params: { id: string } }>("/api/runs/:id/export/trace.json", async (req, reply) => {
    const run = db.getRun(req.params.id)
    if (!run || !canAccessRun(req.session, run)) {
      reply.code(404)
      return { error: "Run not found" }
    }
    const entries = db.getTraceEntries(req.params.id).map((entry) => JSON.parse(entry.data))
    return sendUserDownload(reply, {
      filename: traceExportFilename(req.params.id, "json"),
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify({ runId: req.params.id, entries }, null, 2),
    })
  })

  /**
   * Export markdown tables from the run answer (CSV or JSON).
   * Audited via api_request_log like other authenticated exports.
   * Distinct from agent tool export_query_to_file (full SQL → sandbox).
   */
  app.post<{ Params: { id: string }; Body: TableExportRequest }>(
    "/api/runs/:id/export/tables",
    async (req, reply) => {
      const run = db.getRun(req.params.id)
      if (!run || !canAccessRun(req.session, run)) {
        reply.code(404)
        return { error: "Run not found" }
      }

      const resolved = resolveTablesForExport(run.answer, {
        format: req.body?.format,
        tableIndexes: req.body?.tableIndexes,
      })
      if (!resolved.ok) {
        reply.code(400)
        return { error: resolved.error }
      }

      const { tables } = resolved
      if (req.body.format === "csv") {
        const table = tables[0]!
        return sendUserDownload(reply, {
          filename: tableExportFilename(req.params.id, "csv", { tableIndex: table.index }),
          contentType: "text/csv; charset=utf-8",
          body: serializeAnswerTableCsv(table),
        })
      }

      return sendUserDownload(reply, {
        filename: tableExportFilename(req.params.id, "json", {
          tableIndex: tables.length === 1 ? tables[0]!.index : undefined,
          multi: tables.length > 1,
        }),
        contentType: "application/json; charset=utf-8",
        body: serializeAnswerTablesJson(req.params.id, tables),
      })
    },
  )

  /** List files in the run sandbox the user may download. */
  app.get<{ Params: { id: string } }>("/api/runs/:id/artifacts", async (req, reply) => {
    const run = db.getRun(req.params.id)
    if (!run || !canAccessRun(req.session, run)) {
      reply.code(404)
      return { error: "Run not found" }
    }
    const executionRoot = orchestrator.getRunWorkspaceExecutionRoot(req.params.id)
    if (!executionRoot) {
      return { runId: req.params.id, files: [] }
    }
    const files = await listRunArtifactFiles(executionRoot)
    return { runId: req.params.id, files }
  })

  /** User download — single sandbox file (path after /artifacts/). */
  app.get<{ Params: { id: string; "*": string } }>("/api/runs/:id/artifacts/*", async (req, reply) => {
    const run = db.getRun(req.params.id)
    if (!run || !canAccessRun(req.session, run)) {
      reply.code(404)
      return { error: "Run not found" }
    }
    const executionRoot = orchestrator.getRunWorkspaceExecutionRoot(req.params.id)
    if (!executionRoot) {
      reply.code(404)
      return { error: "No run workspace artifacts available" }
    }
    const relativePath = req.params["*"] ?? ""
    const opened = await openRunArtifactStream(executionRoot, relativePath)
    if (!opened) {
      reply.code(404)
      return { error: "Artifact not found" }
    }
    reply.header("content-type", "application/octet-stream")
    reply.header("content-disposition", `attachment; filename="${opened.filename.replace(/[^\w.\-()+ ]/g, "_")}"`)
    reply.header("content-length", String(opened.sizeBytes))
    return reply.send(opened.stream)
  })

  app.post<{ Params: { id: string }; Body: { useful: boolean; note?: string } }>(
    "/api/runs/:id/feedback",
    async (req, reply) => {
      const run = db.getRun(req.params.id)
      if (!run || !canAccessRun(req.session, run)) {
        reply.code(404)
        return { error: "Run not found" }
      }
      const { useful, note } = req.body ?? {}
      if (useful !== false) {
        return { ok: true, action: MemoryValidationAction.None }
      }
      const flagged = flagRunMemory(req.params.id, note)
      if (!flagged) {
        return { ok: true, action: MemoryValidationAction.NoMemoryEntry }
      }
      return { ok: true, action: MemoryValidationAction.Flagged, runId: req.params.id }
    }
  )

  app.get<{ Params: { id: string } }>("/api/runs/:id/workspace-diff", async (req, reply) => {
    const run = db.getRun(req.params.id)
    if (!run || !canAccessRun(req.session, run)) {
      reply.code(404)
      return { error: "Run not found" }
    }
    const diff = orchestrator.getRunWorkspaceDiff(req.params.id)
    if (!diff) {
      reply.code(404)
      return { error: "No isolated workspace diff available for this run" }
    }
    const sourceRoot = orchestrator.getRunWorkspaceSourceRoot(req.params.id)
    const executionRoot = orchestrator.getRunWorkspaceExecutionRoot(req.params.id)
    return {
      runId: req.params.id,
      added: diff.added,
      modified: diff.modified,
      deleted: diff.deleted,
      total: diff.added.length + diff.modified.length + diff.deleted.length,
      sourceRoot: sourceRoot ?? undefined,
      executionRoot: executionRoot ?? undefined
    }
  })

  app.post<{ Params: { id: string } }>("/api/runs/:id/workspace-diff/apply", async (req, reply) => {
    const run = db.getRun(req.params.id)
    if (!run || !canAccessRun(req.session, run)) {
      reply.code(404)
      return { error: "Run not found" }
    }
    const applied = await orchestrator.applyRunWorkspaceDiff(req.params.id)
    if (!applied) {
      reply.code(404)
      return { error: "No pending isolated workspace diff to apply" }
    }
    return { ok: true, runId: req.params.id, applied }
  })

  app.get("/api/runs/active", async (req) => {
    const ids = orchestrator.getActiveRunIds()
    const visible = ids.filter((id) => {
      const run = db.getRun(id)
      if (!req.session || !run) return false
      return !!run.upn && run.upn.toLowerCase() === req.session.upn.toLowerCase()
    })
    return { runIds: visible }
  })

  app.get("/api/queue", async () => orchestrator.getQueueStats())
}
