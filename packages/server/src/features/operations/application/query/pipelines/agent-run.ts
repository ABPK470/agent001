/**
 * Build an agent-run pipeline: goal as title, run row for status,
 * activities in strict chronological order (first event first in the list).
 */

import { EventType, RunStatus } from "@mia/agent"
import { OperationKind, OperationStatus } from "../../../../../shared/enums/operations.js"
import * as db from "../../../../../platform/persistence/sqlite.js"
import type { OperationActivity, OperationEvent, OperationPipeline } from "../types.js"
import { buildToolIoFromStepEvents, buildToolIoSummary, resolveStepToolName } from "../tool-io.js"
import { durationOf, inferPipelineStatus, numField, strField } from "../utils.js"
import { presentToolCall } from "@mia/shared-types"

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
  const activities = groupAgentRunActivities(events, status)

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

function groupAgentRunActivities(
  events: OperationEvent[],
  pipelineStatus: OperationStatus
): OperationActivity[] {
  const activities: OperationActivity[] = []
  const openSteps: OperationActivity[] = []
  const openAgentSyncExecute = new Map<string, OperationActivity>()

  const closeOpenStep = (endTs: string, failed: boolean, error?: string): void => {
    const step = openSteps.pop()
    if (!step) return
    step.endedAt = endTs
    step.durationMs = durationOf(step.startedAt, endTs)
    if (step.status === OperationStatus.Running) {
      step.status = failed ? OperationStatus.Failed : OperationStatus.Success
    }
    if (error) step.error = error
  }

  const closeAllOpenSteps = (endTs: string, failed: boolean, error?: string): void => {
    while (openSteps.length > 0) closeOpenStep(endTs, failed, error)
  }

  const closeOpenAgentSyncExecute = (planId: string, ev: OperationEvent, failed: boolean): void => {
    const act = openAgentSyncExecute.get(planId)
    if (!act) return
    act.events.push(ev)
    act.endedAt = ev.timestamp
    act.durationMs = durationOf(act.startedAt, ev.timestamp)
    act.status = failed ? OperationStatus.Failed : OperationStatus.Success
    if (failed) {
      const err =
        strField(ev.data, "error") ??
        (typeof ev.data["result"] === "string" ? String(ev.data["result"]) : "Sync execute failed")
      act.error = err
    }
    openAgentSyncExecute.delete(planId)
  }

  for (const ev of events) {
    const t = ev.type

    if (t === EventType.RunQueued) {
      activities.push(instantActivity("queued", "queued", OperationStatus.Success, ev))
      continue
    }
    if (t === EventType.RunStarted) {
      activities.push(instantActivity("started", "started", OperationStatus.Success, ev))
      continue
    }
    if (t === EventType.RunCompleted) {
      closeAllOpenSteps(ev.timestamp, false)
      activities.push(instantActivity("completed", "completed", OperationStatus.Success, ev))
      continue
    }
    if (t === EventType.RunFailed) {
      const error = strField(ev.data, "error") ?? undefined
      closeAllOpenSteps(ev.timestamp, true, error)
      for (const [planId, act] of openAgentSyncExecute) {
        act.status = OperationStatus.Failed
        act.endedAt = ev.timestamp
        act.durationMs = durationOf(act.startedAt, ev.timestamp)
        act.error = error ?? "Agent run failed"
        openAgentSyncExecute.delete(planId)
      }
      activities.push(instantActivity("failed", "failed", OperationStatus.Failed, ev, undefined, error))
      continue
    }
    if (t === EventType.RunCancelled) {
      closeAllOpenSteps(ev.timestamp, true, "Cancelled")
      activities.push(
        instantActivity(
          "cancelled",
          "cancelled",
          OperationStatus.Cancelled,
          ev,
          strField(ev.data, "reason") ?? undefined
        )
      )
      continue
    }

    if (t === EventType.SyncAgentPreview) {
      const planId = strField(ev.data, "planId") ?? "unknown"
      const source = strField(ev.data, "source")
      const target = strField(ev.data, "target")
      activities.push({
        id: `agent-sync-preview:${planId}`,
        name: "Sync preview",
        status: OperationStatus.Success,
        startedAt: ev.timestamp,
        endedAt: ev.timestamp,
        durationMs: 0,
        summary: [
          source && target ? `${source} → ${target}` : null,
          `plan ${planId.slice(0, 8)}`
        ]
          .filter(Boolean)
          .join(" · "),
        details: { planId, phase: "preview", auditHint: "Open full sync audit in Pipelines" },
        events: [ev]
      })
      continue
    }

    if (t === EventType.SyncAgentExecuteStarted) {
      const planId = strField(ev.data, "planId") ?? "unknown"
      const act: OperationActivity = {
        id: `agent-sync-execute:${planId}`,
        name: "Sync execute",
        status: OperationStatus.Running,
        startedAt: ev.timestamp,
        endedAt: null,
        durationMs: null,
        summary: `plan ${planId.slice(0, 8)} · see sync-run audit for step detail`,
        details: { planId, phase: "execute", auditHint: "Open full sync audit in Pipelines" },
        events: [ev]
      }
      activities.push(act)
      openAgentSyncExecute.set(planId, act)
      continue
    }

    if (t === EventType.SyncAgentExecuteCompleted) {
      const planId = strField(ev.data, "planId") ?? "unknown"
      const success = ev.data["success"] !== false
      closeOpenAgentSyncExecute(planId, ev, !success)
      continue
    }

    if (t === EventType.StepStarted) {
      const toolName = resolveStepToolName(ev.data)
      const input = (ev.data["input"] as Record<string, unknown> | undefined) ?? {}
      const argsSummary =
        Object.keys(input).length > 0 ? presentToolCall(toolName, input).summary : undefined
      const act: OperationActivity = {
        id: `step:${activities.length}`,
        name: toolName,
        status: OperationStatus.Running,
        startedAt: ev.timestamp,
        endedAt: null,
        durationMs: null,
        summary: argsSummary,
        events: [ev]
      }
      activities.push(act)
      openSteps.push(act)
      continue
    }

    if (t === EventType.StepCompleted || t === EventType.StepFailed) {
      const step = openSteps.pop()
      if (step) {
        step.events.push(ev)
        step.endedAt = ev.timestamp
        step.durationMs = durationOf(step.startedAt, ev.timestamp)
        step.status = t === EventType.StepCompleted ? OperationStatus.Success : OperationStatus.Failed
        if (t === EventType.StepFailed) step.error = strField(ev.data, "error") ?? "step failed"
        const toolIo = buildToolIoFromStepEvents(step.events)
        if (toolIo) {
          step.details = { toolIo }
          step.summary = buildToolIoSummary(toolIo) ?? step.summary
        } else {
          const dur = numField(ev.data, "durationMs")
          if (dur != null && !step.summary) step.summary = `${(dur / 1000).toFixed(1)}s`
        }
      } else {
        activities.push({
          id: `step-orphan:${activities.length}`,
          name: strField(ev.data, "tool") ?? "step",
          status: t === EventType.StepCompleted ? OperationStatus.Success : OperationStatus.Failed,
          startedAt: ev.timestamp,
          endedAt: ev.timestamp,
          durationMs: numField(ev.data, "durationMs"),
          error: t === EventType.StepFailed ? strField(ev.data, "error") ?? undefined : undefined,
          events: [ev]
        })
      }
      continue
    }

    if (openSteps.length > 0) {
      openSteps[openSteps.length - 1].events.push(ev)
      continue
    }

    activities.push({
      id: `misc:${activities.length}`,
      name: t.replace(/^run\./, "").replace(/\./g, " "),
      status: OperationStatus.Success,
      startedAt: ev.timestamp,
      endedAt: ev.timestamp,
      durationMs: 0,
      events: [ev]
    })
  }

  const lastTs = events[events.length - 1]?.timestamp ?? new Date().toISOString()
  if (pipelineStatus === OperationStatus.Failed || pipelineStatus === OperationStatus.Cancelled) {
    closeAllOpenSteps(lastTs, true)
    for (const act of openAgentSyncExecute.values()) {
      act.status = OperationStatus.Failed
      act.endedAt = lastTs
      act.durationMs = durationOf(act.startedAt, lastTs)
      act.error = act.error ?? "Agent run ended before sync execute completed"
    }
    openAgentSyncExecute.clear()
  }

  return activities
}

function instantActivity(
  id: string,
  name: string,
  status: OperationStatus,
  ev: OperationEvent,
  summary?: string,
  error?: string
): OperationActivity {
  return {
    id,
    name,
    status,
    startedAt: ev.timestamp,
    endedAt: ev.timestamp,
    durationMs: numField(ev.data, "durationMs") ?? 0,
    ...(summary ? { summary } : {}),
    ...(error ? { error } : {}),
    events: [ev]
  }
}
