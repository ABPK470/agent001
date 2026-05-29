import type { DomainEvent, EngineServices } from "@mia/agent"
import { EventType } from "@mia/agent"
import * as db from "../../../adapters/persistence/sqlite.js"
import { NotificationActionType } from "../../../enums/notifications.js"
import { TrajectoryEventKind } from "../../../enums/trajectory.js"
import { broadcast, toBroadcastData } from "../../../event-broadcaster.js"
import type { NotificationOpts } from "../../../ports/orchestration.js"

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

// ── Event wiring ──────────────────────────────────────────────────

/**
 * Subscribe engineServices events to SSE broadcasting and trace recording.
 * Only subscribes to step events — run.completed / run.failed are broadcast
 * explicitly (with full data) after the agent finishes.
 */
export function wireEventBroadcasting(
  services: EngineServices,
  runId: string,
  run: RunLike,
  saveTrace: (runId: string, entry: Record<string, unknown>) => void,
  createNotification: (opts: NotificationOpts) => void,
): void {
  const events: EventType[] = [EventType.RunStarted, EventType.StepStarted, EventType.StepCompleted, EventType.StepFailed]
  for (const eventType of events) {
    services.eventBus.subscribe(eventType, async (event: DomainEvent) => {
      const data = toBroadcastData(event)

      // Enrich step events with details from the run
      if (eventType.startsWith("step.")) {
        const stepId = data["stepId"] as string
        const step = run.steps.find((s) => s.id === stepId)
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
        const toolName = (data["action"] as string) ?? "unknown"
        const stepId = data["stepId"] as string
        const input = (data["input"] as Record<string, unknown>) ?? {}
        const argsFormatted = JSON.stringify(input, null, 2)
        const keys = Object.keys(input)
        // Keep the full single-arg value; the UI clips with CSS ellipsis
        // so users see "…" when the available width runs out.
        const argsSummary = keys.length > 0
          ? keys.length === 1 ? `${keys[0]}=${JSON.stringify(input[keys[0]])}` : `${keys.length} args`
          : ""
        // invocationId MUST be present so the UI can pair tool-call with
        // its later tool-result/tool-error entry. Without it, historical
        // trace replay (TermChat / AgentChat / IOE chat) drops the result
        // text and only shows the input — leaving every tool row in the
        // expanded view without an output panel.
        saveTrace(runId, { kind: TrajectoryEventKind.ToolCall, invocationId: stepId, tool: toolName, argsSummary, argsFormatted })
      } else if (eventType === EventType.StepCompleted) {
        const stepId = data["stepId"] as string
        const output = (data["output"] as Record<string, unknown>) ?? {}
        const result = (output["result"] as string) ?? (Object.keys(output).length > 0 ? JSON.stringify(output) : "done")
        saveTrace(runId, { kind: TrajectoryEventKind.ToolResult, invocationId: stepId, text: result })
      } else if (eventType === EventType.StepFailed) {
        const stepId = data["stepId"] as string
        saveTrace(runId, { kind: TrajectoryEventKind.ToolError, invocationId: stepId, text: (data["error"] as string) ?? "unknown error" })
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
          logMsg = `${(data["action"] as string) ?? "unknown"} started`
          break
        case EventType.StepCompleted:
          logMsg = `${(data["action"] as string) ?? "unknown"} completed`
          break
        case EventType.StepFailed:
          logMsg = `${(data["action"] as string) ?? "unknown"} failed — ${((data["error"] as string) ?? "unknown").slice(0, 200)}`
          break
        default:
          logMsg = eventType.replace(/^[^.]+\./, "")
      }
      db.saveLog({
        run_id: runId,
        level: isError ? `${typeGroup}:error` : typeGroup,
        message: logMsg,
        timestamp: new Date().toISOString(),
      })
    })
  }

  // Intercept audit service to broadcast entries in real-time
  const originalLog = services.auditService.log.bind(services.auditService)
  services.auditService.log = async (entry) => {
    const result = await originalLog(entry)
    broadcast({ type: EventType.Audit, data: { actor: entry.actor, action: entry.action, detail: entry.detail ?? {} } })
    return result
  }

  // Approval requests → notifications
  services.eventBus.subscribe("approval.required", async (event: DomainEvent) => {
    const data = toBroadcastData(event)
    const toolName = data["toolName"] as string
    const reason = data["reason"] as string
    const stepId = data["stepId"] as string
    createNotification({
      type: EventType.ApprovalRequired,
      title: "Approval required",
      message: `Tool "${toolName}" needs approval: ${reason}`,
      runId,
      stepId,
      actions: [
        { label: "Review", action: NotificationActionType.ViewRun, data: { runId } },
        { label: "Edit Policies", action: NotificationActionType.OpenPolicies, data: { runId } },
      ],
    })
    broadcast({ type: EventType.ApprovalRequired, data: { runId, stepId, toolName, reason } })
  })
}
