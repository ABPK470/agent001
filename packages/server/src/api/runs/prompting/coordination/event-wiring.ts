import type { DomainEvent, Unsubscribe } from "@mia/agent"
import { EventType } from "@mia/agent"
import { presentToolCall, serializeToolCallArgs } from "@mia/shared-types"
import { broadcast, toBroadcastData } from "../../../../infra/events/broadcaster.js"
import * as db from "../../../../infra/persistence/sqlite.js"
import { TrajectoryEventKind } from "../../../../internal/enums/trajectory.js"

type EventWiringServices = {
  eventBus: {
    subscribe(eventType: string, listener: (event: DomainEvent) => Promise<void>): Unsubscribe
  }
  auditLog: {
    subscribe(
      listener: (entry: { actor: string; action: string; detail?: unknown }) => Promise<void>
    ): Unsubscribe
  }
}

type RunLike = {
  steps: Array<{
    id: string
    name: string
    action: string
    input: Record<string, unknown>
    output: Record<string, unknown>
    error: string | null
  }>
}

type RunStateLike = {
  run: RunLike
}

type RunScopedEvent = DomainEvent & { runId?: unknown }
type StepScopedEvent = DomainEvent & { stepId?: unknown }

function getEventRunId(event: DomainEvent): string | null {
  const runId = (event as RunScopedEvent).runId
  if (typeof runId === "string" && runId.length > 0) return runId
  return null
}

function getStepId(event: DomainEvent): string | null {
  const stepId = (event as StepScopedEvent).stepId
  if (typeof stepId === "string" && stepId.length > 0) return stepId
  return null
}

function resolveToolName(data: Record<string, unknown>): string {
  if (typeof data["action"] === "string" && data["action"].trim().length > 0) return data["action"]
  if (typeof data["name"] === "string" && data["name"].trim().length > 0) return data["name"]
  return "unknown"
}

// ── Event wiring ──────────────────────────────────────────────────

/**
 * Subscribe engineServices events to SSE broadcasting and trace recording.
 * Only subscribes to step events — run.completed / run.failed are broadcast
 * explicitly (with full data) after the agent finishes.
 */
export function wireEventBroadcasting(
  services: EventWiringServices,
  runId: string,
  // Keep a live reference to the mutable state holder because state.run is
  // replaced immutably during execution.
  state: RunStateLike,
  saveTrace: (runId: string, entry: Record<string, unknown>) => void
): Unsubscribe {
  const events: EventType[] = [
    EventType.RunStarted,
    EventType.StepStarted,
    EventType.StepCompleted,
    EventType.StepFailed
  ]
  const subscriptions: Unsubscribe[] = []
  for (const eventType of events) {
    const unsubscribe = services.eventBus.subscribe(eventType, async (event: DomainEvent) => {
      const data = toBroadcastData(event)
      const eventRunId = getEventRunId(event)
      if (eventRunId && eventRunId !== runId) return

      // Enrich step events with details from the run
      if (eventType.startsWith("step.")) {
        const stepId = getStepId(event)
        const step = state.run.steps.find((s) => s.id === stepId)
        if (step) {
          data["name"] = step.name
          data["action"] = step.action
          data["input"] = step.input
          data["output"] = step.output
          data["error"] = step.error
        }
      }

      broadcast({ type: eventType, data })

      if (eventType === EventType.StepStarted) {
        const toolName = resolveToolName(data)
        const stepId = getStepId(event)
        const input = (data["input"] as Record<string, unknown>) ?? {}
        const { summary: argsSummary } = presentToolCall(toolName, input)
        const argsFormatted = serializeToolCallArgs(input)
        // invocationId MUST be present so the UI can pair tool-call with
        // its later tool-result/tool-error entry. Without it, historical
        // trace replay (TermChat / AgentChat / IOE chat) drops the result
        // text and only shows the input — leaving every tool row in the
        // expanded view without an output panel.
        saveTrace(runId, {
          kind: TrajectoryEventKind.ToolCall,
          invocationId: stepId,
          tool: toolName,
          argsSummary,
          argsFormatted
        })
      } else if (eventType === EventType.StepCompleted) {
        const stepId = getStepId(event)
        const output = (data["output"] as Record<string, unknown>) ?? {}
        const result =
          (output["result"] as string) ?? (Object.keys(output).length > 0 ? JSON.stringify(output) : "done")
        saveTrace(runId, { kind: TrajectoryEventKind.ToolResult, invocationId: stepId, text: result })
      } else if (eventType === EventType.StepFailed) {
        const stepId = getStepId(event)
        saveTrace(runId, {
          kind: TrajectoryEventKind.ToolError,
          invocationId: stepId,
          text: (data["error"] as string) ?? "unknown error"
        })
      }

      // Save a human-readable log (not raw JSON) with the type group
      // so historical logs display identically to live SSE events.
      const typeGroup = eventType.startsWith("step.") || eventType.startsWith("tool_call.") ? "step" : "run"
      const isError = eventType.includes("failed")
      let logMsg: string
      switch (eventType) {
        case EventType.RunStarted:
          logMsg = `Started — run ${(data["runId"] as string)?.slice(0, 8) ?? "?"}`
          break
        case EventType.StepStarted:
          logMsg = `${resolveToolName(data)} started`
          break
        case EventType.StepCompleted:
          logMsg = `${resolveToolName(data)} completed`
          break
        case EventType.StepFailed:
          logMsg = `${resolveToolName(data)} failed — ${((data["error"] as string) ?? "unknown").slice(0, 200)}`
          break
        default:
          logMsg = eventType.replace(/^[^.]+\./, "")
      }
      db.saveLog({
        run_id: runId,
        level: isError ? `${typeGroup}:error` : typeGroup,
        message: logMsg,
        timestamp: new Date().toISOString()
      })
    })
    subscriptions.push(unsubscribe)
  }

  const unsubscribeAudit = services.auditLog.subscribe(async (entry) => {
    broadcast({
      type: EventType.Audit,
      data: { actor: entry.actor, action: entry.action, detail: entry.detail ?? {} }
    })
  })
  subscriptions.push(unsubscribeAudit)

  // Approval requests → live SSE only; notification + DB record created in finalizeWaitingForApprovalRun.
  const unsubscribeApproval = services.eventBus.subscribe("approval.required", async (event: DomainEvent) => {
    const data = toBroadcastData(event)
    const eventRunId = getEventRunId(event)
    if (eventRunId && eventRunId !== runId) return
    broadcast({ type: EventType.ApprovalRequired, data: { ...data, runId: eventRunId ?? runId } })
  })
  subscriptions.push(unsubscribeApproval)

  return () => {
    for (const unsubscribe of subscriptions.splice(0)) {
      unsubscribe()
    }
  }
}
