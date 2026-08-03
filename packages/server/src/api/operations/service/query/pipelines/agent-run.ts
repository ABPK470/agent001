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
import { presentToolCall, serializeToolCallArgs } from "@mia/shared-types"

export async function buildAgentRunPipeline(runId: string, events: OperationEvent[]): Promise<OperationPipeline> {
  const run = await db.getRun(runId)
  const startedAt = events[0].timestamp
  const lastEv = events[events.length - 1]
  const status: OperationStatus =
    run?.status === RunStatus.Completed
      ? OperationStatus.Success
      : run?.status === RunStatus.Failed || run?.status === RunStatus.Crashed
        ? OperationStatus.Failed
        : run?.status === RunStatus.Cancelled
          ? OperationStatus.Cancelled
          : run?.status === RunStatus.WaitingForApproval
            ? OperationStatus.Skipped
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
    actorUpn: run?.upn ?? null,
    title: goal.length > 100 ? goal.slice(0, 97) + "…" : goal,
    subtitle: run ? `${run.step_count} steps` : undefined,
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
  // Most recent step activity (open or closed). tool_call.completed/killed after
  // step.completed fold into it (unregister races past step close).
  let lastStepActivity: OperationActivity | null = null
  // tool_call.executing is broadcast BEFORE step.started (kill-manager register
  // wraps govern-tool). Buffer those orphans and fold into the next step — never
  // emit a bare "Tool call" telemetry row when a step is about to arrive.
  let pendingToolCalls: OperationEvent[] = []

  const closeTelemetryGroup = (): void => {
    openTelemetry = null
    openTelemetryType = null
  }

  const attachToolIo = (step: OperationActivity): void => {
    const toolIo = buildToolIoFromStepEvents(step.events)
    if (!toolIo) return
    step.details = { ...(step.details ?? {}), toolIo }
    step.summary = buildToolIoSummary(toolIo) ?? step.summary
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

  /** When step.* never arrived (window gap / persist miss), promote buffered
   *  tool_call.* into a named tool row instead of opaque "Tool call" telemetry.
   *  `parked` closes orphans that never got completed/killed (policy approval). */
  const flushPendingToolCalls = (parked?: {
    reason: string
    toolName?: string
    event: OperationEvent
    /** When no buffered tool_call.* existed, synthesize a row from approval alone. */
    createIfEmpty?: boolean
  }): void => {
    if (pendingToolCalls.length === 0 && !parked) return
    closeTelemetryGroup()
    const byCallId = new Map<string, OperationEvent[]>()
    for (const ev of pendingToolCalls) {
      const callId = strField(ev.data, "toolCallId") ?? `anon:${ev.timestamp}:${byCallId.size}`
      const bucket = byCallId.get(callId)
      if (bucket) bucket.push(ev)
      else byCallId.set(callId, [ev])
    }
    pendingToolCalls = []

    const parkReason = parked?.reason
    const parkTool = parked?.toolName

    for (const evs of byCallId.values()) {
      const toolName =
        evs
          .map((e) => strField(e.data, "toolName"))
          .find((n): n is string => typeof n === "string" && n.length > 0) ??
        (parkTool && evs.some((e) => e.type === EventType.ToolCallExecuting) ? parkTool : undefined)
      if (!toolName) {
        for (const ev of evs) appendTelemetryEvent(ev.type, ev)
        continue
      }
      const startedAt = evs[0]!.timestamp
      const endedAt = parked?.event.timestamp ?? evs[evs.length - 1]!.timestamp
      const killed = evs.some((e) => e.type === EventType.ToolCallKilled)
      const finished = evs.some(
        (e) => e.type === EventType.ToolCallCompleted || e.type === EventType.ToolCallKilled
      )
      const matchesPark = !parkTool || toolName === parkTool
      const awaitingApproval = Boolean(parkReason) && matchesPark && !finished && !killed
      const allEvents =
        awaitingApproval && parked ? [...evs, parked.event] : evs
      const approvalIo = awaitingApproval && parked ? toolIoInputFromApproval(parked.event) : {}
      const act: OperationActivity = {
        id: `step-synth:${activities.length}`,
        name: toolName,
        status: killed
          ? OperationStatus.Failed
          : finished
            ? OperationStatus.Success
            : awaitingApproval
              ? OperationStatus.Skipped
              : OperationStatus.Running,
        startedAt,
        endedAt: finished || killed || awaitingApproval ? endedAt : null,
        durationMs:
          finished || killed || awaitingApproval ? durationOf(startedAt, endedAt) : null,
        ...(awaitingApproval ? { error: parkReason, summary: parkReason } : {}),
        details: {
          toolIo: {
            tool: toolName,
            status: killed
              ? "failed"
              : finished
                ? "success"
                : awaitingApproval
                  ? "skipped"
                  : "running",
            durationMs:
              finished || killed || awaitingApproval ? durationOf(startedAt, endedAt) : null,
            ...(awaitingApproval ? { error: parkReason } : {}),
            ...approvalIo
          }
        },
        events: allEvents
      }
      activities.push(act)
      lastStepActivity = act
    }

    // Approval for a tool that never got tool_call.executing (or was already
    // flushed) — still surface a parked row from the approval payload.
    if (parked?.createIfEmpty && byCallId.size === 0 && parkTool) {
      const ts = parked.event.timestamp
      const act: OperationActivity = {
        id: `step-synth:${activities.length}`,
        name: parkTool,
        status: OperationStatus.Skipped,
        startedAt: ts,
        endedAt: ts,
        durationMs: 0,
        error: parkReason,
        summary: parkReason,
        details: {
          toolIo: {
            tool: parkTool,
            status: "skipped",
            error: parkReason,
            durationMs: 0,
            ...toolIoInputFromApproval(parked.event)
          }
        },
        events: [parked.event]
      }
      activities.push(act)
      lastStepActivity = act
    }
  }

  const parkOpenStepForApproval = (ev: OperationEvent, reason: string): void => {
    const step = openSteps.pop()
    if (!step) return
    step.events.push(ev)
    step.endedAt = ev.timestamp
    step.durationMs = durationOf(step.startedAt, ev.timestamp)
    step.status = OperationStatus.Skipped
    step.error = reason
    step.summary = reason
    const tool = strField(ev.data, "toolName") ?? step.name
    step.details = {
      ...(step.details ?? {}),
      toolIo: {
        tool,
        status: "skipped",
        error: reason,
        durationMs: step.durationMs,
        ...toolIoInputFromApproval(ev)
      }
    }
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
    attachToolIo(step)
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
      flushPendingToolCalls()
      closeTelemetryGroup()
      activities.push(instantActivity("queued", "queued", OperationStatus.Success, ev))
      continue
    }
    if (t === EventType.RunStarted) {
      flushPendingToolCalls()
      closeTelemetryGroup()
      activities.push(instantActivity("started", "started", OperationStatus.Success, ev))
      continue
    }
    if (t === EventType.RunCompleted) {
      flushPendingToolCalls()
      closeTelemetryGroup()
      closeAllOpenSteps(ev.timestamp, false)
      activities.push(instantActivity("completed", "completed", OperationStatus.Success, ev))
      continue
    }
    if (t === EventType.RunFailed) {
      flushPendingToolCalls()
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
      flushPendingToolCalls()
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

    // Policy gate parked the tool before step.* completed — close the orphan
    // tool_call.executing (and any open step) as skipped, not running forever.
    if (t === EventType.ApprovalRequired) {
      closeTelemetryGroup()
      const reason =
        strField(ev.data, "reason") ??
        strField(ev.data, "policyName") ??
        "Awaiting approval"
      const toolName = strField(ev.data, "toolName") ?? undefined
      const hadOpenSteps = openSteps.length > 0
      while (openSteps.length > 0) parkOpenStepForApproval(ev, reason)
      flushPendingToolCalls({
        reason,
        toolName,
        event: ev,
        createIfEmpty: !hadOpenSteps
      })
      activities.push(
        instantActivity(
          `approval:${activities.length}`,
          "approval required",
          OperationStatus.Skipped,
          ev,
          reason
        )
      )
      continue
    }

    if (t === EventType.SyncAgentPreview) {
      flushPendingToolCalls()
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
      flushPendingToolCalls()
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
      const prior = pendingToolCalls
      pendingToolCalls = []
      const act: OperationActivity = {
        id: `step:${activities.length}`,
        name: toolName,
        status: OperationStatus.Running,
        startedAt: prior[0]?.timestamp ?? ev.timestamp,
        endedAt: null,
        durationMs: null,
        summary: argsSummary,
        events: [...prior, ev]
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
        attachToolIo(step)
        if (!step.details?.["toolIo"]) {
          const dur = numField(ev.data, "durationMs")
          if (dur != null && !step.summary) step.summary = `${(dur / 1000).toFixed(1)}s`
        }
      } else {
        flushPendingToolCalls()
        closeTelemetryGroup()
        const orphan: OperationActivity = {
          id: `step-orphan:${activities.length}`,
          name: resolveStepToolName(ev.data),
          status: t === EventType.StepCompleted ? OperationStatus.Success : OperationStatus.Failed,
          startedAt: ev.timestamp,
          endedAt: ev.timestamp,
          durationMs: numField(ev.data, "durationMs"),
          error: t === EventType.StepFailed ? strField(ev.data, "error") ?? undefined : undefined,
          events: [ev]
        }
        attachToolIo(orphan)
        activities.push(orphan)
        lastStepActivity = orphan
      }
      continue
    }

    // tool_call.* are kill-management signals wrapping the same tool execution
    // a step.* row already represents (with full I/O).
    // - open step: fold in
    // - completed/killed after step close: fold into last step (unregister race)
    // - executing before step.started: buffer (never lastStep — that is the prior tool)
    if (
      t === EventType.ToolCallExecuting ||
      t === EventType.ToolCallCompleted ||
      t === EventType.ToolCallKilled
    ) {
      if (openSteps.length > 0) {
        closeTelemetryGroup()
        openSteps[openSteps.length - 1]!.events.push(ev)
        continue
      }
      if (
        (t === EventType.ToolCallCompleted || t === EventType.ToolCallKilled) &&
        lastStepActivity &&
        pendingToolCalls.length === 0
      ) {
        closeTelemetryGroup()
        lastStepActivity.events.push(ev)
        continue
      }
      pendingToolCalls.push(ev)
      continue
    }

    // Non-action event (debug.trace, checkpoint.saved, usage.updated, …).
    // Sibling telemetry rows — even while a step is open — keep tool rows clean.
    flushPendingToolCalls()
    appendTelemetryEvent(t, ev)
  }

  flushPendingToolCalls()
  const lastTs = events[events.length - 1]?.timestamp ?? new Date().toISOString()
  if (
    pipelineStatus === OperationStatus.Failed ||
    pipelineStatus === OperationStatus.Cancelled ||
    pipelineStatus === OperationStatus.Skipped
  ) {
    const terminal =
      pipelineStatus === OperationStatus.Cancelled
        ? OperationStatus.Cancelled
        : pipelineStatus === OperationStatus.Skipped
          ? OperationStatus.Skipped
          : OperationStatus.Failed
    const terminalError =
      pipelineStatus === OperationStatus.Cancelled
        ? "Cancelled"
        : pipelineStatus === OperationStatus.Skipped
          ? "Awaiting approval"
          : undefined
    closeAllOpenSteps(lastTs, terminal === OperationStatus.Failed, terminalError)
    for (const [planId, act] of openAgentSyncExecute) {
      act.status = OperationStatus.Failed
      act.endedAt = lastTs
      act.durationMs = durationOf(act.startedAt, lastTs)
      act.error = act.error ?? "Agent run ended before sync execute completed"
      openAgentSyncExecute.delete(planId)
    }
    // Synth tool rows from orphan tool_call.executing stay "running" unless closed here.
    for (const act of activities) {
      if (act.status !== OperationStatus.Running) continue
      act.status = terminal
      act.endedAt = lastTs
      act.durationMs = durationOf(act.startedAt, lastTs)
      if (terminalError && !act.error) act.error = terminalError
      const toolIo = act.details?.["toolIo"]
      if (toolIo && typeof toolIo === "object" && !Array.isArray(toolIo)) {
        const io = toolIo as Record<string, unknown>
        if (io["status"] === "running") {
          io["status"] = terminal === OperationStatus.Skipped ? "skipped" : "failed"
          if (terminalError && typeof io["error"] !== "string") io["error"] = terminalError
          io["durationMs"] = act.durationMs
        }
      }
    }
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

function toolIoInputFromApproval(ev: OperationEvent): {
  input?: Record<string, unknown>
  inputFormatted?: string
  argsSummary?: string
} {
  const args = ev.data["args"]
  if (!args || typeof args !== "object" || Array.isArray(args)) return {}
  const input = args as Record<string, unknown>
  if (Object.keys(input).length === 0) return {}
  const tool = strField(ev.data, "toolName") ?? "tool"
  const presentation = presentToolCall(tool, input)
  return {
    input,
    inputFormatted: serializeToolCallArgs(input),
    ...(presentation.summary ? { argsSummary: presentation.summary } : {})
  }
}
