import type { Agent } from "@mia/agent"
import { EventType, RunStatus } from "@mia/agent"
import { randomUUID } from "node:crypto"
import { broadcast } from "../../../infra/events/broadcaster.js"
import * as db from "../../../infra/persistence/sqlite.js"
import type { ActiveRun, NotificationOpts } from "../../../ports/orchestration.js"
import type { AuditLogPort } from "./run-executor/types.js"
// ── Trace ─────────────────────────────────────────────────────────

export function saveTrace(
  activeRuns: Map<string, ActiveRun>,
  runId: string,
  entry: Record<string, unknown>
): void {
  const active = activeRuns.get(runId)
  const seq = active ? active.traceSeq++ : 0
  db.saveTraceEntry({
    run_id: runId,
    seq,
    data: JSON.stringify(entry),
    created_at: new Date().toISOString()
  })
}

// ── Run persistence ───────────────────────────────────────────────

export function persistRun(
  run: { id: string; status: RunStatus; steps: unknown[]; createdAt: Date; completedAt: Date | null },
  goal: string,
  parentRunId?: string,
  answer?: string,
  error?: string
): void {
  db.saveRun({
    id: run.id,
    goal,
    status: run.status,
    answer: answer ?? null,
    step_count: run.steps.length,
    error: error ?? null,
    parent_run_id: parentRunId ?? null,
    created_at: run.createdAt.toISOString(),
    completed_at: run.completedAt?.toISOString() ?? null
  })
}

export async function persistAuditLog(auditLog: AuditLogPort, runId: string): Promise<void> {
  const entries = await auditLog.history("AgentRun", runId)
  for (const entry of entries) {
    db.saveAudit({
      run_id: runId,
      actor: entry.actor,
      action: entry.action,
      detail: JSON.stringify(entry.detail),
      timestamp: entry.timestamp.toISOString()
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
      model: process.env["MODEL"] ?? "gpt-5.4",
      created_at: new Date().toISOString()
    })
  }
}

// ── Notifications ─────────────────────────────────────────────────

export function createNotification(opts: NotificationOpts): void {
  // Stamp tenancy onto the notification so list queries can scope by
  // owner without joining back to runs. If we have a run_id, prefer the
  // run's persisted owner (consistent with how the run was launched);
  // otherwise fall back to the current request's session context.
  // v19: owner_upn is NOT NULL — every notification belongs to a real
  // user. If neither source resolves a upn, that's a programmer error
  // (background task firing a notification without a run + without an
  // ALS-bound session) and we want it to surface loudly.
  let ownerUpn: string | null = null
  if (opts.runId) {
    const r = db.getRun(opts.runId)
    if (r) ownerUpn = r.upn ?? null
  }
  if (!ownerUpn) {
    throw new Error("createNotification: no owner upn (no runId match and no current session)")
  }

  const notification: db.DbNotification = {
    id: randomUUID(),
    type: opts.type,
    title: opts.title,
    message: opts.message,
    run_id: opts.runId ?? null,
    step_id: opts.stepId ?? null,
    owner_upn: ownerUpn,
    actions: JSON.stringify(opts.actions ?? []),
    read: 0,
    created_at: new Date().toISOString()
  }
  db.saveNotification(notification)
  broadcast({
    type: EventType.Notification,
    data: {
      id: notification.id,
      notificationType: notification.type,
      title: notification.title,
      message: notification.message,
      runId: notification.run_id,
      stepId: notification.step_id,
      actions: opts.actions ?? [],
      read: false
    }
  })
}
