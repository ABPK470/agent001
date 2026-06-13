/**
 * Build an agent-run pipeline: goal as title, run row for status,
 * activities for lifecycle, tool steps, and inline sync sub-jobs.
 */

import { EventType, RunStatus } from "@mia/agent"
import { OperationKind, OperationStatus } from "../../../../../shared/enums/operations.js"
import * as db from "../../../../../platform/persistence/sqlite.js"
import type { OperationActivity, OperationEvent, OperationPipeline } from "../types.js"
import { durationOf, inferPipelineStatus, strField } from "../utils.js"
import { summariseSyncEvents } from "./sync.js"

export function buildAgentRunPipeline(runId: string, events: OperationEvent[]): OperationPipeline {
  const run = db.getRun(runId)
  const startedAt = events[0].timestamp
  const lastEv = events[events.length - 1]
  const status: OperationStatus =
    run?.status === RunStatus.Completed
      ? OperationStatus.Success
      : run?.status === RunStatus.Failed
        ? OperationStatus.Failed
        : run?.status === RunStatus.Cancelled
          ? OperationStatus.Cancelled
          : run?.status === RunStatus.Running ||
              run?.status === RunStatus.Planning ||
              run?.status === RunStatus.Pending
            ? OperationStatus.Running
            : inferPipelineStatus(events)
  const endedAt = run?.completed_at ?? (status !== OperationStatus.Running ? lastEv.timestamp : null)
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
    activities
  }
}

function groupAgentRunActivities(events: OperationEvent[]): OperationActivity[] {
  const activities: OperationActivity[] = []
  const lifecycleEvents: OperationEvent[] = []
  const otherEvents: OperationEvent[] = []
  const syncPlans = new Map<string, { kind: "preview" | "execute"; events: OperationEvent[] }>()

  type Open = { idx: number; act: OperationActivity }
  const openSteps: Open[] = []

  for (const ev of events) {
    const t = ev.type

    if (
      t === EventType.RunQueued ||
      t === EventType.RunStarted ||
      t === EventType.RunCompleted ||
      t === EventType.RunFailed ||
      t === EventType.RunCancelled
    ) {
      lifecycleEvents.push(ev)
      continue
    }

    if (t.startsWith("sync.")) {
      const planId = strField(ev.data, "planId") ?? "unknown"
      const kind: "preview" | "execute" = t.startsWith("sync.execute") ? "execute" : "preview"
      let bucket = syncPlans.get(planId)
      if (!bucket) {
        bucket = { kind, events: [] }
        syncPlans.set(planId, bucket)
      }
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
        events: [ev]
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

    if (openSteps.length > 0) {
      openSteps[openSteps.length - 1].act.events.push(ev)
      continue
    }
    otherEvents.push(ev)
  }

  for (const [planId, bucket] of syncPlans) {
    const start = bucket.events[0].timestamp
    const last = bucket.events[bucket.events.length - 1]
    const status = inferPipelineStatus(bucket.events)
    const endedAt = status !== OperationStatus.Running ? last.timestamp : null
    activities.push({
      id: `sync:${planId}`,
      name: `sync ${bucket.kind} — ${planId.slice(0, 8)}`,
      status,
      startedAt: start,
      endedAt,
      durationMs: durationOf(start, endedAt),
      summary: summariseSyncEvents(bucket.kind, bucket.events),
      events: bucket.events
    })
  }

  activities.sort((a, b) => a.startedAt.localeCompare(b.startedAt))

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
      events: lifecycleEvents
    })
  }

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
      events: otherEvents
    })
  }

  return activities
}
