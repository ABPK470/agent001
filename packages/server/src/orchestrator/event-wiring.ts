import type { DomainEvent, EngineServices } from "@agent001/agent"
import * as db from "../db.js"
import { broadcast } from "../ws.js"
import type { NotificationOpts } from "./types.js"

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
 * Subscribe engineServices events to WebSocket broadcasting and trace recording.
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
  const events = ["run.started", "step.started", "step.completed", "step.failed"]
  for (const eventType of events) {
    services.eventBus.subscribe(eventType, async (event: DomainEvent) => {
      const data = event as unknown as Record<string, unknown>

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

      if (eventType === "step.started") {
        const toolName = (data["action"] as string) ?? "unknown"
        const input = (data["input"] as Record<string, unknown>) ?? {}
        const argsFormatted = JSON.stringify(input, null, 2)
        const keys = Object.keys(input)
        const argsSummary = keys.length > 0
          ? keys.length === 1 ? `${keys[0]}=${JSON.stringify(input[keys[0]])}`.slice(0, 60) : `${keys.length} args`
          : ""
        saveTrace(runId, { kind: "tool-call", tool: toolName, argsSummary, argsFormatted })
      } else if (eventType === "step.completed") {
        const output = (data["output"] as Record<string, unknown>) ?? {}
        const result = (output["result"] as string) ?? (Object.keys(output).length > 0 ? JSON.stringify(output) : "done")
        saveTrace(runId, { kind: "tool-result", text: result })
      } else if (eventType === "step.failed") {
        saveTrace(runId, { kind: "tool-error", text: (data["error"] as string) ?? "unknown error" })
      }

      db.saveLog({
        run_id: runId,
        level: eventType.includes("failed") ? "error" : "info",
        message: `${eventType}: ${JSON.stringify(event)}`,
        timestamp: new Date().toISOString(),
      })
    })
  }

  // Intercept audit service to broadcast entries in real-time
  const originalLog = services.auditService.log.bind(services.auditService)
  services.auditService.log = async (entry) => {
    const result = await originalLog(entry)
    broadcast({ type: "audit", data: { actor: entry.actor, action: entry.action, detail: entry.detail ?? {} } })
    return result
  }

  // Approval requests → notifications
  services.eventBus.subscribe("approval.required", async (event: DomainEvent) => {
    const data = event as unknown as Record<string, unknown>
    const toolName = data["toolName"] as string
    const reason = data["reason"] as string
    const stepId = data["stepId"] as string
    createNotification({
      type: "approval.required",
      title: "Approval required",
      message: `Tool "${toolName}" needs approval: ${reason}`,
      runId,
      stepId,
      actions: [
        { label: "Review", action: "view-run", data: { runId } },
        { label: "Edit Policies", action: "open-policies", data: { runId } },
      ],
    })
    broadcast({ type: "approval.required", data: { runId, stepId, toolName, reason } })
  })
}
