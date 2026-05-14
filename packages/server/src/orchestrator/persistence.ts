import type { Agent, EngineServices } from "@mia/agent"
import { randomUUID } from "node:crypto"
import { getCurrentSession } from "../auth/context.js"
import * as db from "../db.js"
import { broadcast } from "../event-broadcaster.js"
import type { ActiveRun, NotificationOpts } from "./types.js"
// ── Trace ─────────────────────────────────────────────────────────

export function saveTrace(
  activeRuns: Map<string, ActiveRun>,
  runId: string,
  entry: Record<string, unknown>,
): void {
  const active = activeRuns.get(runId)
  const seq = active ? active.traceSeq++ : 0
  db.saveTraceEntry({
    run_id: runId,
    seq,
    data: JSON.stringify(entry),
    created_at: new Date().toISOString(),
  })
}

// ── Run persistence ───────────────────────────────────────────────

export function persistRun(
  run: { id: string; status: string; steps: unknown[]; createdAt: Date; completedAt: Date | null },
  goal: string,
  agentId: string | null,
  parentRunId?: string,
  answer?: string,
  error?: string,
): void {
  db.saveRun({
    id: run.id,
    goal,
    status: run.status,
    answer: answer ?? null,
    step_count: run.steps.length,
    error: error ?? null,
    parent_run_id: parentRunId ?? null,
    agent_id: agentId,
    created_at: run.createdAt.toISOString(),
    completed_at: run.completedAt?.toISOString() ?? null,
  })
}

export async function persistAuditLog(services: EngineServices, runId: string): Promise<void> {
  const entries = await services.auditService.history("AgentRun", runId)
  for (const entry of entries) {
    db.saveAudit({
      run_id: runId,
      actor: entry.actor,
      action: entry.action,
      detail: JSON.stringify(entry.detail),
      timestamp: entry.timestamp.toISOString(),
    })
  }
}

export function persistTokenUsage(runId: string, agent: Agent): void {
  if (agent.usage.totalTokens > 0 || agent.llmCalls > 0) {
    db.saveTokenUsage({
      run_id: runId,
      prompt_tokens: agent.usage.promptTokens,
      completion_tokens: agent.usage.completionTokens,
      total_tokens: agent.usage.totalTokens,
      llm_calls: agent.llmCalls,
      model: process.env["MODEL"] ?? "gpt-4o",
      created_at: new Date().toISOString(),
    })
  }
}

// ── Notifications ─────────────────────────────────────────────────

export function createNotification(opts: NotificationOpts): void {
  // Stamp tenancy onto the notification so list queries can scope by
  // owner without joining back to runs. If we have a run_id, prefer the
  // run's persisted owner (consistent with how the run was launched);
  // otherwise fall back to the current request's session context.
  let ownerUpn: string | null = null
  let sessionId: string | null = null
  if (opts.runId) {
    const r = db.getRun(opts.runId)
    if (r) {
      ownerUpn  = r.upn          ?? null
      sessionId = r.session_id   ?? null
    }
  }
  if (!ownerUpn || !sessionId) {
    const ctx = getCurrentSession()
    if (ctx) {
      ownerUpn  = ownerUpn  ?? ctx.upn ?? null
      sessionId = sessionId ?? ctx.sid
    }
  }

  const notification: db.DbNotification = {
    id: randomUUID(),
    type: opts.type,
    title: opts.title,
    message: opts.message,
    run_id: opts.runId ?? null,
    step_id: opts.stepId ?? null,
    owner_upn: ownerUpn,
    session_id: sessionId,
    actions: JSON.stringify(opts.actions ?? []),
    read: 0,
    created_at: new Date().toISOString(),
  }
  db.saveNotification(notification)
  broadcast({
    type: "notification",
    data: {
      id: notification.id,
      notificationType: notification.type,
      title: notification.title,
      message: notification.message,
      runId: notification.run_id,
      stepId: notification.step_id,
      actions: opts.actions ?? [],
      read: false,
    },
  })
}
