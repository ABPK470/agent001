/**
 * Build an agent-run pipeline: goal as title, run row for status,
 * activities in strict chronological order (first event first in the list).
 */

import { EventType, RunStatus } from "@mia/agent"
import { OperationKind, OperationStatus } from "../../../../../internal/enums/operations.js"
import * as db from "../../../../../infra/persistence/sqlite.js"
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

/**
 * Telemetry event types — the "supporting detail" stream of an agent run.
 *
 * These fire many times per run (one `debug.trace` per iteration/thinking/llm
 * phase, one `checkpoint.saved` per tool call, …) and carry no action semantics
 * of their own. Left ungrouped they each became a one-event "misc" row, which
 * is the repetition the operator sees. We collapse every event of a given
 * telemetry type into a single expandable activity row ("Debug trace", …)
 * appended after the chronological action timeline, so the action stream
 * (lifecycle + steps + sync delegation) stays clean and primary while the
 * debug/telemetry detail is one expand to reveal the per-kind entries.
 */
const TELEMETRY_LABELS: Record<string, string> = {
  [EventType.DebugTrace]: "Debug trace",
  [EventType.UsageUpdated]: "Usage",
  [EventType.CheckpointSaved]: "Checkpoint",
  [EventType.ToolCallExecuting]: "Tool call",
  [EventType.ToolCallCompleted]: "Tool call",
  [EventType.ToolCallKilled]: "Tool call",
  [EventType.DelegationIteration]: "Delegation",
  [EventType.PlannerDelegationIteration]: "Delegation",
}

function telemetryLabel(type: string): string {
  return TELEMETRY_LABELS[type] ?? type.replace(/^run\./, "").replace(/\./g, " ")
}

function summarizeTelemetryBucket(type: string, evs: OperationEvent[]): string {
  if (type === EventType.DebugTrace) {
    const kinds = new Set<string>()
    for (const ev of evs) {
      const entry = ev.data["entry"]
      const k = entry && typeof entry === "object" ? (entry as Record<string, unknown>)["kind"] : null
      if (typeof k === "string") kinds.add(k)
    }
    const kindList = [...kinds].slice(0, 6).join(", ")
    return `${evs.length} entries${kindList ? ` · ${kindList}` : ""}`
  }
  return `${evs.length} entries`
}

function groupAgentRunActivities(
  events: OperationEvent[],
  pipelineStatus: OperationStatus
): OperationActivity[] {
  const activities: OperationActivity[] = []
  const openSteps: OperationActivity[] = []
  const openAgentSyncExecute = new Map<string, OperationActivity>()
  // The single currently-open telemetry group (a run of consecutive same-type
  // orphan events: debug.trace, usage.updated, memory.*, notification, …).
  // It is emitted IN CHRONOLOGICAL POSITION — appended to `activities` when the
  // first event of a run arrives, and closed (further appends stop) the moment a
  // different-type event or an action row (lifecycle/step/sync) is emitted. This
  // is what keeps the pipeline a faithful timeline: each burst of reasoning/
  // telemetry collapses to one expandable row exactly where it happened, instead
  // of one row per event or all telemetry dumped at the end.
  let openTelemetry: OperationActivity | null = null
  let openTelemetryType: string | null = null
  // Most recent step activity (open or closed). Orphan tool_call.* kill-signals
  // fold into it so every tool — including ask_user — is a step row, never a
  // separate generic "Tool call" telemetry row.
  let lastStepActivity: OperationActivity | null = null

  const closeTelemetryGroup = (): void => {
    openTelemetry = null
    openTelemetryType = null
  }

  const appendTelemetryEvent = (type: string, ev: OperationEvent): void => {
    if (openTelemetry && openTelemetryType === type) {
      openTelemetry.events.push(ev)
      openTelemetry.endedAt = ev.timestamp
      openTelemetry.durationMs = durationOf(openTelemetry.startedAt, ev.timestamp)
      return
    }
    closeTelemetryGroup()
    openTelemetryType = type
    openTelemetry = {
      id: `telemetry:${type}:${activities.length}`,
      name: telemetryLabel(type),
      status: OperationStatus.Success,
      startedAt: ev.timestamp,
      endedAt: ev.timestamp,
      durationMs: 0,
      details: { telemetryType: type },
      events: [ev]
    }
    activities.push(openTelemetry)
  }

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
      closeTelemetryGroup()
      activities.push(instantActivity("queued", "queued", OperationStatus.Success, ev))
      continue
    }
    if (t === EventType.RunStarted) {
      closeTelemetryGroup()
      activities.push(instantActivity("started", "started", OperationStatus.Success, ev))
      continue
    }
    if (t === EventType.RunCompleted) {
      closeTelemetryGroup()
      closeAllOpenSteps(ev.timestamp, false)
      activities.push(instantActivity("completed", "completed", OperationStatus.Success, ev))
      continue
    }
    if (t === EventType.RunFailed) {
      closeTelemetryGroup()
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
      closeTelemetryGroup()
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
      closeTelemetryGroup()
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
      closeTelemetryGroup()
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
      closeTelemetryGroup()
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
      lastStepActivity = act
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
        closeTelemetryGroup()
        const orphan: OperationActivity = {
          id: `step-orphan:${activities.length}`,
          name: strField(ev.data, "tool") ?? "step",
          status: t === EventType.StepCompleted ? OperationStatus.Success : OperationStatus.Failed,
          startedAt: ev.timestamp,
          endedAt: ev.timestamp,
          durationMs: numField(ev.data, "durationMs"),
          error: t === EventType.StepFailed ? strField(ev.data, "error") ?? undefined : undefined,
          events: [ev]
        }
        activities.push(orphan)
        lastStepActivity = orphan
      }
      continue
    }

    if (openSteps.length > 0) {
      openSteps[openSteps.length - 1].events.push(ev)
      continue
    }

    // tool_call.* are kill-management signals wrapping the same tool execution
    // a step.* row already represents (with full I/O). Fold them into the most
    // recent step so every tool — including ask_user — is a step row, never a
    // separate generic "Tool call" telemetry row.
    if (
      t === EventType.ToolCallExecuting ||
      t === EventType.ToolCallCompleted ||
      t === EventType.ToolCallKilled
    ) {
      if (lastStepActivity) {
        closeTelemetryGroup()
        lastStepActivity.events.push(ev)
        continue
      }
      // No preceding step to fold into — degrade to a telemetry row.
      appendTelemetryEvent(t, ev)
      continue
    }

    // Orphan non-action event (debug.trace, checkpoint.saved, usage.updated,
    // memory.*, notification, …). Group consecutive same-type events into one
    // expandable row in chronological position — not one row per event.
    appendTelemetryEvent(t, ev)
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

  // Finalize telemetry groups: compute each group's summary and terminal
  // status from its accumulated events. (They were already pushed to
  // `activities` in chronological position as they opened; this only fills in
  // the aggregate fields that depend on the full event set.)
  for (const act of activities) {
    if (!act.id.startsWith("telemetry:")) continue
    const type = (act.details?.["telemetryType"] as string | undefined) ?? act.id
    act.summary = summarizeTelemetryBucket(type, act.events)
    const hasFailure = act.events.some((ev) => {
      if (ev.type.includes(".failed")) return true
      if (typeof ev.data["error"] === "string") return true
      // debug.trace carries its failure as entry.kind === "error" | "tool-error".
      const entry = ev.data["entry"]
      const k = entry && typeof entry === "object" ? (entry as Record<string, unknown>)["kind"] : null
      return k === "error" || k === "tool-error"
    })
    act.status = hasFailure ? OperationStatus.Failed : OperationStatus.Success
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
