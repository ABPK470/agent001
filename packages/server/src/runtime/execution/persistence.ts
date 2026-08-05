import type { Agent } from "@mia/agent"
import { EventType, RunStatus } from "@mia/agent"
import { randomUUID } from "node:crypto"
import { broadcast } from "../../infra/events/broadcaster.js"
import * as db from "../../infra/persistence/sqlite.js"
import type { ActiveRun, NotificationOpts } from "../../ports/orchestration.js"
import type { AuditLogPort } from "./run-executor/types.js"
// ── Trace ─────────────────────────────────────────────────────────

type TraceWriteState = Pick<
  ActiveRun,
  "traceSeq" | "traceWrites" | "traceWriteError"
>

export function saveTrace(
  activeRuns: ReadonlyMap<string, TraceWriteState>,
  runId: string,
  entry: Record<string, unknown>
): Promise<void> {
  const active = activeRuns.get(runId)
  const seq = active ? active.traceSeq++ : 0
  const write = () =>
    db.saveTraceEntry({
      run_id: runId,
      seq,
      data: JSON.stringify(entry),
      created_at: new Date().toISOString()
    })
  if (!active) return write()

  const pendingWrite = active.traceWrites.then(write)
  active.traceWrites = pendingWrite.catch((error: unknown) => {
    active.traceWriteError ??= error
    console.error(`[trace] write failed for run ${runId} at seq ${seq}:`, error)
  })
  return pendingWrite.then(() => {
    if (active.traceWriteError !== null) throw active.traceWriteError
  })
}

export async function flushTrace(
  activeRuns: ReadonlyMap<string, TraceWriteState>,
  runId: string
): Promise<void> {
  const active = activeRuns.get(runId)
  if (!active) return
  await active.traceWrites
  if (active.traceWriteError !== null) throw active.traceWriteError
}

// ── Run persistence ───────────────────────────────────────────────

export async function persistRun(
  run: { id: string; status: RunStatus; steps: unknown[]; createdAt: Date; completedAt: Date | null },
  goal: string,
  parentRunId?: string,
  answer?: string,
  error?: string
): Promise<void> {
  await db.saveRun({
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
    await db.saveAudit({
      run_id: runId,
      actor: entry.actor,
      action: entry.action,
      detail: JSON.stringify(entry.detail),
      timestamp: entry.timestamp.toISOString()
    })
  }
}

export async function persistTokenUsage(runId: string, agent: Agent): Promise<void> {
  if (agent.usage.totalTokens > 0 || agent.llmCalls > 0) {
    await db.saveTokenUsage({
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

export async function createNotification(opts: NotificationOpts): Promise<void> {
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
    const r = await db.getRun(opts.runId)
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
  await db.saveNotification(notification)
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
