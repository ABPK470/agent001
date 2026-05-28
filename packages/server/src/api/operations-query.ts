/**
 * Operation Log — three-level history grouping.
 *
 * Walks the persisted event_log + agent runs + sync_runs tables and produces
 * a tree structured as:
 *
 *   Pipeline (top-level operation: agent run, sync preview, sync execute, system)
 *     └─ Activity (logical step / phase within the pipeline)
 *           └─ Event (raw individual emitted event)
 *
 * The grouping rules are:
 *
 *   1. Events with `data.runId` → grouped under that agent run pipeline.
 *      Sync events that ALSO carry a runId become activities under the run
 *      (rather than separate sync pipelines), so an agent that triggers a
 *      sync shows the sync inline as one of its activities.
 *
 *   2. Events with `data.planId` but no `data.runId` → standalone sync
 *      pipeline (preview or execute). Preview vs execute is inferred from
 *      the event type prefix.
 *
 *   3. Anything else → 'system' bucket grouped per minute (low-priority).
 *
 * Designed to be cheap to call for the most-recent N events. Caller paginates
 * by supplying `before` (ISO timestamp).
 */

import { EventType, isCancellationEvent, isCompletionEvent, isEventType, isFailureEvent, isSubStepFailureEvent, RunStatus } from "@mia/agent"
import { SyncRunStatus } from "@mia/shared-enums"
import * as db from "../adapters/persistence/sqlite.js"
import { OperationKind, OperationStatus } from "../enums/operations.js"

// ── Types ────────────────────────────────────────────────────────

export { OperationKind, OperationStatus }

export interface OperationEvent {
  type: EventType
  timestamp: string
  data: Record<string, unknown>
}

export interface OperationActivity {
  id: string                // unique within pipeline
  name: string              // display label
  status: OperationStatus
  startedAt: string
  endedAt: string | null
  durationMs: number | null
  summary?: string          // optional one-line outcome ("12 rows applied", "0 ins / 0 upd")
  error?: string
  events: OperationEvent[]
}

export interface OperationPipeline {
  id: string                // runId / planId / system bucket key
  kind: OperationKind
  title: string             // human label ("contract#4879 uat → dev", "ABI search query for ...")
  subtitle?: string         // secondary context
  status: OperationStatus
  startedAt: string
  endedAt: string | null
  durationMs: number | null
  activityCount: number
  eventCount: number
  error?: string
  activities: OperationActivity[]
}

// ── Public API ───────────────────────────────────────────────────

export interface ListOperationsOpts {
  limit?: number          // max events to scan (default 1000, hard-capped at 5000)
  before?: string         // ISO cursor — scan events strictly before this
  search?: string         // post-filter: text match on title/subtitle
  kind?: string           // post-filter: agent-run | sync-preview | sync-execute | system | all
  status?: string         // post-filter: running | success | failed | cancelled | all
}

export function listOperations(opts: ListOperationsOpts = {}): {
  operations: OperationPipeline[]
  scannedEvents: number
  oldestTimestamp: string | null
} {
  const limit = Math.min(opts.limit ?? 1000, 5000)
  const events = db.listEvents({ limit, before: opts.before })
  if (events.length === 0) {
    return { operations: [], scannedEvents: 0, oldestTimestamp: null }
  }

  // events come back newest-first → reverse to chronological for grouping.
  // Validate type at the storage boundary: any row whose `type` is not a
  // known EventType is dropped (stale data from removed event names).
  const chrono = [...events].reverse().flatMap<OperationEvent>((e) => {
    if (!isEventType(e.type)) return []
    return [{ type: e.type, timestamp: e.created_at, data: safeParse(e.data) }]
  })

  // ── Pass 1: split into per-correlation buckets ─────────────────
  // Standalone sync pipelines take precedence over agent-run bucketing.
  // Without this, a preview+execute pair for the same plan collapses into a
  // single entry, and agent-triggered sync traces disappear inside the parent
  // run pipeline.
  type Bucket = { kind: OperationKind; key: string; events: OperationEvent[]; planId?: string }
  const buckets = new Map<string, Bucket>()

  for (const ev of chrono) {
    const runId = strField(ev.data, "runId")
    const planId = strField(ev.data, "planId")

    let kind: OperationKind
    let key: string
    let bucketPlanId: string | undefined
    if (planId && ev.type.startsWith("sync.execute")) {
      kind = OperationKind.SyncExecute
      key = `plan:${planId}:execute`
      bucketPlanId = planId
    } else if (planId && ev.type.startsWith("sync.preview")) {
      kind = OperationKind.SyncPreview
      key = `plan:${planId}:preview`
      bucketPlanId = planId
    } else if (runId) {
      kind = OperationKind.AgentRun
      key = `run:${runId}`
    } else {
      kind = OperationKind.System
      // bucket per minute
      key = `system:${ev.timestamp.slice(0, 16)}`
    }

    let b = buckets.get(key)
    if (!b) {
      b = { kind, key, events: [], ...(bucketPlanId ? { planId: bucketPlanId } : {}) }
      buckets.set(key, b)
    }
    b.events.push(ev)
  }

  // ── Pass 2: enrich each bucket with run/sync_runs metadata ─────
  const operations: OperationPipeline[] = []
  for (const b of buckets.values()) {
    if (b.kind === OperationKind.AgentRun) {
      const runId = b.key.slice(4)
      operations.push(buildAgentRunPipeline(runId, b.events))
    } else if (b.kind === OperationKind.SyncPreview || b.kind === OperationKind.SyncExecute) {
      const planId = b.planId ?? b.key.slice(5)
      operations.push(buildSyncPipeline(planId, b.kind, b.events))
    } else {
      operations.push(buildSystemPipeline(b.key, b.events))
    }
  }

  // newest-first for the UI
  operations.sort((a, b) => b.startedAt.localeCompare(a.startedAt))

  // Post-filter by search/kind/status if requested
  let filtered = operations
  if (opts.kind && opts.kind !== "all") {
    filtered = filtered.filter((p) => p.kind === opts.kind)
  }
  if (opts.status && opts.status !== "all") {
    filtered = filtered.filter((p) => p.status === opts.status)
  }
  if (opts.search) {
    const needle = opts.search.toLowerCase()
    filtered = filtered.filter((p) =>
      p.title.toLowerCase().includes(needle) ||
      (p.subtitle ?? "").toLowerCase().includes(needle) ||
      p.id.toLowerCase().includes(needle) ||
      (p.error ?? "").toLowerCase().includes(needle) ||
      p.activities.some(
        (a) =>
          a.name.toLowerCase().includes(needle) ||
          (a.summary ?? "").toLowerCase().includes(needle) ||
          (a.error ?? "").toLowerCase().includes(needle) ||
          a.events.some((e) => e.type.toLowerCase().includes(needle)),
      )
    )
  }

  return {
    operations: filtered,
    scannedEvents: events.length,
    oldestTimestamp: events[events.length - 1]?.created_at ?? null,
  }
}

// ── Helpers ──────────────────────────────────────────────────────

function safeParse(s: string): Record<string, unknown> {
  try { return JSON.parse(s) as Record<string, unknown> } catch { return {} }
}

function strField(d: Record<string, unknown>, k: string): string | null {
  const v = d[k]
  return typeof v === "string" && v.length > 0 ? v : null
}

function durationOf(start: string, end: string | null): number | null {
  if (!end) return null
  const a = Date.parse(start)
  const b = Date.parse(end)
  return Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, b - a) : null
}

function humanizeEntityType(value: string | null | undefined): string {
  if (!value) return "Entity"
  switch (value) {
    case "pipelineActivity": return "Pipeline Activity"
    case "gateMetadata": return "Gate Metadata"
    default:
      return value
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/[_-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/\b\w/g, (char) => char.toUpperCase())
  }
}

function inferPipelineStatus(events: OperationEvent[]): OperationStatus {
  // Sub-step failures (e.g. sync.execute.step.failed) are emitted BEFORE
  // sync.execute.completed, so a naive backwards scan finds .completed first
  // and incorrectly returns OperationStatus.Success. Pre-scan for these so
  // they poison a downstream completion.
  const hasSubStepFailure = events.some((e) => isSubStepFailureEvent(e.type))
  for (let i = events.length - 1; i >= 0; i--) {
    const t = events[i].type
    if (isCompletionEvent(t)) return hasSubStepFailure ? OperationStatus.Failed : OperationStatus.Success
    if (isFailureEvent(t)) return OperationStatus.Failed
    if (isCancellationEvent(t)) return OperationStatus.Cancelled
  }
  return hasSubStepFailure ? OperationStatus.Failed : OperationStatus.Running
}

// ── Pipeline builders ────────────────────────────────────────────

function buildAgentRunPipeline(runId: string, events: OperationEvent[]): OperationPipeline {
  const run = db.getRun(runId)
  const startedAt = events[0].timestamp
  const lastEv = events[events.length - 1]
  const status: OperationStatus = run?.status === RunStatus.Completed ? OperationStatus.Success
    : run?.status === RunStatus.Failed ? OperationStatus.Failed
    : run?.status === RunStatus.Cancelled ? OperationStatus.Cancelled
    : run?.status === RunStatus.Running || run?.status === RunStatus.Planning || run?.status === RunStatus.Pending ? OperationStatus.Running
    : inferPipelineStatus(events)
  const endedAt = run?.completed_at
    ?? (status !== OperationStatus.Running ? lastEv.timestamp : null)
  const goal = run?.goal ?? strField(lastEv.data, "goal") ?? `run ${runId.slice(0, 8)}`

  const activities = groupAgentRunActivities(events)

  return {
    id: runId,
    kind: OperationKind.AgentRun,
    title: goal.length > 100 ? goal.slice(0, 97) + "…" : goal,
    subtitle: run ? `${run.step_count} steps · ${run.agent_id ?? "agent"}` : undefined,
    status,
    startedAt,
    endedAt,
    durationMs: durationOf(startedAt, endedAt),
    activityCount: activities.length,
    eventCount: events.length,
    error: run?.error ?? undefined,
    activities,
  }
}

function groupAgentRunActivities(events: OperationEvent[]): OperationActivity[] {
  // Activities for an agent run:
  //   - Each tool call (step.started → step.completed/.failed) is one activity.
  //   - Lifecycle (run.queued/started/completed/failed/cancelled) collapsed
  //     into a single "lifecycle" activity at the start.
  //   - Sync events under this run are grouped per planId into "sync preview"
  //     / "sync execute" activities.
  //   - Anything else (agent.thinking, api.*, audit.*) → "other" activity at end.
  const activities: OperationActivity[] = []
  const lifecycleEvents: OperationEvent[] = []
  const otherEvents: OperationEvent[] = []
  const syncPlans = new Map<string, { kind: "preview" | "execute"; events: OperationEvent[] }>()

  // step.started → activity; subsequent events with matching toolCallId / index
  // accumulate; step.completed/.failed closes it. Track open-step by stack.
  type Open = { idx: number; act: OperationActivity }
  const openSteps: Open[] = []

  for (const ev of events) {
    const t = ev.type

    if (t === EventType.RunQueued || t === EventType.RunStarted || t === EventType.RunCompleted || t === EventType.RunFailed || t === EventType.RunCancelled) {
      lifecycleEvents.push(ev)
      continue
    }

    if (t.startsWith("sync.")) {
      const planId = strField(ev.data, "planId") ?? OperationStatus.Unknown
      const kind: "preview" | "execute" = t.startsWith("sync.execute") ? "execute" : "preview"
      let bucket = syncPlans.get(planId)
      if (!bucket) { bucket = { kind, events: [] }; syncPlans.set(planId, bucket) }
      bucket.events.push(ev)
      continue
    }

    if (t === EventType.StepStarted) {
      const toolName = strField(ev.data, "tool") ?? strField(ev.data, "name") ?? "step"
      const act: OperationActivity = {
        id: `step:${activities.length}`,
        name: toolName,
        status: OperationStatus.Running,
        startedAt: ev.timestamp,
        endedAt: null,
        durationMs: null,
        events: [ev],
      }
      activities.push(act)
      openSteps.push({ idx: activities.length - 1, act })
      continue
    }
    if (t === EventType.StepCompleted || t === EventType.StepFailed) {
      const open = openSteps.pop()
      if (open) {
        open.act.events.push(ev)
        open.act.endedAt = ev.timestamp
        open.act.durationMs = durationOf(open.act.startedAt, ev.timestamp)
        open.act.status = t === EventType.StepCompleted ? OperationStatus.Success : OperationStatus.Failed
        if (t === EventType.StepFailed) open.act.error = strField(ev.data, "error") ?? "step failed"
        const dur = ev.data["durationMs"]
        if (typeof dur === "number" && !open.act.summary) {
          open.act.summary = `${(dur / 1000).toFixed(1)}s`
        }
      } else {
        otherEvents.push(ev)
      }
      continue
    }
    // Sub-event of an open step → attach to it
    if (openSteps.length > 0) {
      openSteps[openSteps.length - 1].act.events.push(ev)
      continue
    }
    otherEvents.push(ev)
  }

  // Flush sync plan activities — render each as its own activity.
  for (const [planId, bucket] of syncPlans) {
    const start = bucket.events[0].timestamp
    const last = bucket.events[bucket.events.length - 1]
    const status = inferPipelineStatus(bucket.events)
    const endedAt = status !== OperationStatus.Running ? last.timestamp : null
    const summary = summariseSyncEvents(bucket.kind, bucket.events)
    activities.push({
      id: `sync:${planId}`,
      name: `sync ${bucket.kind} — ${planId.slice(0, 8)}`,
      status,
      startedAt: start,
      endedAt,
      durationMs: durationOf(start, endedAt),
      summary,
      events: bucket.events,
    })
  }

  // Sort activities by start time ascending so the UI reads chronologically
  activities.sort((a, b) => a.startedAt.localeCompare(b.startedAt))

  // Prepend lifecycle if any
  if (lifecycleEvents.length > 0) {
    const start = lifecycleEvents[0].timestamp
    const end = lifecycleEvents[lifecycleEvents.length - 1].timestamp
    activities.unshift({
      id: "lifecycle",
      name: "lifecycle",
      status: inferPipelineStatus(lifecycleEvents),
      startedAt: start,
      endedAt: end,
      durationMs: durationOf(start, end),
      events: lifecycleEvents,
    })
  }
  // Append other events as a misc activity
  if (otherEvents.length > 0) {
    const start = otherEvents[0].timestamp
    const end = otherEvents[otherEvents.length - 1].timestamp
    activities.push({
      id: "misc",
      name: "other events",
      status: OperationStatus.Success,
      startedAt: start,
      endedAt: end,
      durationMs: durationOf(start, end),
      events: otherEvents,
    })
  }

  return activities
}

function buildSyncPipeline(planId: string, kind: typeof OperationKind.SyncPreview | typeof OperationKind.SyncExecute, events: OperationEvent[]): OperationPipeline {
  const meta = db.getSyncRun?.(planId)
  const startedAt = events[0].timestamp
  const lastEv = events[events.length - 1]
  const status: OperationStatus = meta?.status === SyncRunStatus.Success ? OperationStatus.Success
    : meta?.status === SyncRunStatus.Failed ? OperationStatus.Failed
    : inferPipelineStatus(events)
  const endedAt = meta?.finished_at ?? (status !== OperationStatus.Running ? lastEv.timestamp : null)
  const entityTypeLabel = humanizeEntityType(meta?.entity_type)
  const entityName = meta?.entity_display_name ?? `${meta?.entity_type ?? "?"}#${meta?.entity_id ?? "?"}`
  const route = meta ? `${meta.source} → ${meta.target}` : ""

  let activities: OperationActivity[]
  if (kind === OperationKind.SyncPreview) {
    activities = groupSyncPreviewActivities(events)
  } else {
    activities = groupSyncExecuteActivities(events)
  }

  return {
    id: planId,
    kind,
    title: `${kind === OperationKind.SyncExecute ? "Execute" : "Preview"} ${entityTypeLabel} — ${entityName}`,
    subtitle: route || planId.slice(0, 8),
    status,
    startedAt,
    endedAt,
    durationMs: meta?.duration_ms ?? durationOf(startedAt, endedAt),
    activityCount: activities.length,
    eventCount: events.length,
    error: meta?.error ?? undefined,
    activities,
  }
}

function groupSyncPreviewActivities(events: OperationEvent[]): OperationActivity[] {
  // One activity per table scan (table.start → table.done).
  // Phase events (started, completed, failed, drift) → single "phases" activity.
  const activities: OperationActivity[] = []
  const phaseEvents: OperationEvent[] = []
  const openTables = new Map<string, OperationActivity>()

  for (const ev of events) {
    const t = ev.type
    const table = strField(ev.data, "table")
    if (t === EventType.SyncPreviewTableStart && table) {
      const act: OperationActivity = {
        id: `tbl:${table}:${activities.length}`,
        name: table,
        status: OperationStatus.Running,
        startedAt: ev.timestamp,
        endedAt: null,
        durationMs: null,
        events: [ev],
      }
      activities.push(act)
      openTables.set(table, act)
      continue
    }
    if ((t === EventType.SyncPreviewTableDone || t === EventType.SyncPreviewTableFailed) && table) {
      const open = openTables.get(table)
      if (open) {
        open.events.push(ev)
        open.endedAt = ev.timestamp
        open.durationMs = durationOf(open.startedAt, ev.timestamp)
        open.status = t === EventType.SyncPreviewTableDone ? OperationStatus.Success : OperationStatus.Failed
        if (t === EventType.SyncPreviewTableFailed) open.error = strField(ev.data, "error") ?? "scan failed"
        const ins = numField(ev.data, "insert"), upd = numField(ev.data, "update"), del = numField(ev.data, "delete")
        if (ins != null && upd != null && del != null) {
          open.summary = `${ins} ins · ${upd} upd · ${del} del`
        }
        openTables.delete(table)
      } else {
        phaseEvents.push(ev)
      }
      continue
    }
    if (table && openTables.has(table)) {
      openTables.get(table)!.events.push(ev)
      continue
    }
    phaseEvents.push(ev)
  }

  if (phaseEvents.length > 0) {
    const start = phaseEvents[0].timestamp
    const end = phaseEvents[phaseEvents.length - 1].timestamp
    activities.unshift({
      id: "phases",
      name: "phases",
      status: inferPipelineStatus(phaseEvents),
      startedAt: start,
      endedAt: end,
      durationMs: durationOf(start, end),
      events: phaseEvents,
    })
  }

  return activities
}

function groupSyncExecuteActivities(events: OperationEvent[]): OperationActivity[] {
  // Activities for execute:
  //   - Each `sync.execute.step` opens a new activity that absorbs subsequent
  //     SQL / probe events until the next step or table.start.
  //   - Each `sync.execute.table.start` opens a table activity, table.done closes it.
  //   - Execute lifecycle events (`started`, `completed`, `failed`, etc.) become
  //     their own top-level activities so the UI shows them alongside the steps.
  const activities: OperationActivity[] = []
  let currentStep: OperationActivity | null = null
  let currentTable: { name: string; act: OperationActivity } | null = null

  const closeStep = (endTs: string): void => {
    if (currentStep) {
      currentStep.endedAt = endTs
      currentStep.durationMs = durationOf(currentStep.startedAt, endTs)
      if (currentStep.status === OperationStatus.Running) currentStep.status = OperationStatus.Success
      currentStep = null
    }
  }

  const closeTable = (endTs: string): void => {
    if (currentTable) {
      currentTable.act.endedAt = endTs
      currentTable.act.durationMs = durationOf(currentTable.act.startedAt, endTs)
      if (currentTable.act.status === OperationStatus.Running) currentTable.act.status = OperationStatus.Success
      currentTable = null
    }
  }

  const pushLifecycleActivity = (ev: OperationEvent): void => {
    const type = ev.type
    let name = type.replace(/^sync\.execute\./, "")
    let status = OperationStatus.Success
    let summary: string | undefined
    let error: string | undefined

    if (type === EventType.SyncExecuteStarted) {
      status = OperationStatus.Success
      const source = strField(ev.data, "source")
      const target = strField(ev.data, "target")
      summary = source && target ? `${source} → ${target}` : undefined
    } else if (type === EventType.SyncExecuteCompleted) {
      status = OperationStatus.Success
      const applied = ev.data["applied"] as Record<string, unknown> | undefined
      if (applied) {
        summary = `${applied["insert"] ?? 0} ins · ${applied["update"] ?? 0} upd · ${applied["delete"] ?? 0} del`
      }
    } else if (type === EventType.SyncExecuteFailed) {
      status = OperationStatus.Failed
      error = strField(ev.data, "error") ?? undefined
      summary = error
    } else if (type === EventType.SyncExecuteDriftRevalidated) {
      status = OperationStatus.Success
      const maxDriftPct = numField(ev.data, "maxDriftPct")
      summary = maxDriftPct != null ? `max drift ${(maxDriftPct * 100).toFixed(1)}%` : undefined
    } else if (type === EventType.SyncExecuteArchiveSkipped) {
      status = OperationStatus.Success
      summary = strField(ev.data, "reason") ?? undefined
    } else if (type === EventType.SyncExecuteArchiveProbeBatch) {
      status = OperationStatus.Success
      const tables = Array.isArray(ev.data["tables"]) ? (ev.data["tables"] as unknown[]).length : null
      const durationMs = numField(ev.data, "durationMs")
      summary = [tables != null ? `${tables} tables` : null, durationMs != null ? `${durationMs}ms` : null].filter(Boolean).join(" · ") || undefined
    }

    activities.push({
      id: `elifecycle:${activities.length}`,
      name,
      status,
      startedAt: ev.timestamp,
      endedAt: ev.timestamp,
      durationMs: 0,
      ...(summary ? { summary } : {}),
      ...(error ? { error } : {}),
      events: [ev],
    })
  }

  for (const ev of events) {
    const t = ev.type
    if (
      t === EventType.SyncExecuteStarted
      || t === EventType.SyncExecuteCompleted
      || t === EventType.SyncExecuteFailed
      || t === EventType.SyncExecuteDriftRevalidated
      || t === EventType.SyncExecuteArchiveSkipped
      || t === EventType.SyncExecuteArchiveProbeBatch
    ) {
      closeTable(ev.timestamp)
      closeStep(ev.timestamp)
      pushLifecycleActivity(ev)
      continue
    }
    if (t === EventType.SyncExecuteStep) {
      closeStep(ev.timestamp)
      const stepName = strField(ev.data, "step") ?? "step"
      currentStep = {
        id: `estep:${activities.length}`,
        name: stepName,
        status: OperationStatus.Running,
        startedAt: ev.timestamp,
        endedAt: null,
        durationMs: null,
        events: [ev],
      }
      activities.push(currentStep)
      continue
    }
    if (t === EventType.SyncExecuteStepFailed) {
      const stepName = strField(ev.data, "step") ?? "step"
      const errMsg = strField(ev.data, "error") ?? OperationStatus.Failed
      // Try to attach to currently-open step matching the name; otherwise new
      // failed activity.
      if (currentStep && currentStep.name === stepName) {
        currentStep.events.push(ev)
        currentStep.status = OperationStatus.Failed
        currentStep.error = errMsg
        currentStep.endedAt = ev.timestamp
        currentStep.durationMs = durationOf(currentStep.startedAt, ev.timestamp)
        currentStep = null
      } else {
        activities.push({
          id: `estep:${activities.length}`,
          name: stepName,
          status: OperationStatus.Failed,
          startedAt: ev.timestamp,
          endedAt: ev.timestamp,
          durationMs: 0,
          error: errMsg,
          events: [ev],
        })
      }
      continue
    }
    if (t === EventType.SyncExecuteTableStart) {
      closeStep(ev.timestamp)
      const tableName = strField(ev.data, "table") ?? "table"
      const op = strField(ev.data, "op") ?? "apply"
      const rows = numField(ev.data, "rowsTotal")
      const act: OperationActivity = {
        id: `etbl:${activities.length}`,
        name: `${tableName} (${op}${rows != null ? ` ${rows} rows` : ""})`,
        status: OperationStatus.Running,
        startedAt: ev.timestamp,
        endedAt: null,
        durationMs: null,
        events: [ev],
      }
      activities.push(act)
      currentTable = { name: tableName, act }
      continue
    }
    if (t === EventType.SyncExecuteTableDone && currentTable) {
      currentTable.act.events.push(ev)
      currentTable.act.endedAt = ev.timestamp
      currentTable.act.durationMs = durationOf(currentTable.act.startedAt, ev.timestamp)
      currentTable.act.status = OperationStatus.Success
      const applied = numField(ev.data, "rowsApplied")
      if (applied != null) currentTable.act.summary = `${applied} rows applied`
      currentTable = null
      continue
    }
    if (t === EventType.SyncExecuteTableDone) {
      pushLifecycleActivity(ev)
      continue
    }

    // Sub-event under whichever activity is currently open
    if (currentTable) {
      currentTable.act.events.push(ev)
      continue
    }
    if (currentStep) {
      currentStep.events.push(ev)
      continue
    }

    pushLifecycleActivity(ev)
  }

  // Close any leftover open step at the timestamp of last event
  if (currentStep) {
    closeStep(events[events.length - 1].timestamp)
  }

  return activities
}

function buildSystemPipeline(key: string, events: OperationEvent[]): OperationPipeline {
  const startedAt = events[0].timestamp
  const endedAt = events[events.length - 1].timestamp
  const minute = key.slice(7) // strip "system:"
  return {
    id: key,
    kind: OperationKind.System,
    title: `System events — ${minute.replace("T", " ")}`,
    status: OperationStatus.Success,
    startedAt,
    endedAt,
    durationMs: durationOf(startedAt, endedAt),
    activityCount: 1,
    eventCount: events.length,
    activities: [{
      id: "events",
      name: "events",
      status: OperationStatus.Success,
      startedAt,
      endedAt,
      durationMs: durationOf(startedAt, endedAt),
      events,
    }],
  }
}

function summariseSyncEvents(kind: "preview" | "execute", events: OperationEvent[]): string | undefined {
  // Find the .completed event and extract a brief summary
  for (const ev of events) {
    if (kind === "preview" && ev.type === EventType.SyncPreviewCompleted) {
      const totals = ev.data["totals"] as Record<string, unknown> | undefined
      if (totals) return `${totals["insert"] ?? 0} ins · ${totals["update"] ?? 0} upd · ${totals["delete"] ?? 0} del`
    }
    if (kind === "execute" && ev.type === EventType.SyncExecuteCompleted) {
      const applied = ev.data["applied"] as Record<string, unknown> | undefined
      if (applied) return `${applied["insert"] ?? 0} ins · ${applied["update"] ?? 0} upd · ${applied["delete"] ?? 0} del`
    }
  }
  return undefined
}

function numField(d: Record<string, unknown>, k: string): number | null {
  const v = d[k]
  return typeof v === "number" ? v : null
}
