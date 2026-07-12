import type { SyncExecuteProgress } from "../../types"
import type { ExecState } from "./types"

export type ExecTableStatus = "running" | "done" | "failed" | "cancelled"

/** Derive per-table execute indicators for plan rows and the exec modal. */
export function buildExecTableStatus(exec: ExecState): Map<string, ExecTableStatus> {
  const statuses = new Map<string, ExecTableStatus>()
  if (exec.kind === "idle") return statuses

  for (const event of exec.events) {
    if (!event.table) continue
    if (event.type === "table-started") statuses.set(event.table, "running")
    if (event.type === "table-done") statuses.set(event.table, "done")
  }

  if (exec.kind === "running") return statuses

  const cancelled = exec.kind === "done" && exec.error?.toLowerCase().includes("cancel")
  for (const event of exec.events) {
    if (event.type === "failed") {
      for (const [tableName, state] of statuses) {
        if (state === "running") statuses.set(tableName, cancelled ? "cancelled" : "failed")
      }
    }
  }

  // Cancel / client abort — no server `failed` event, but tables may still be `running`.
  if (exec.kind === "done" && !exec.success) {
    const metadataFailed = exec.events.some(
      (event) =>
        event.type === "failed"
        && (event.step === "metadataSync" || event.error?.includes("metadataSync")),
    )
    if (metadataFailed) {
      for (const [tableName, state] of statuses) {
        if (state === "done") statuses.set(tableName, "failed")
      }
    }
    for (const [tableName, state] of statuses) {
      if (state === "running") statuses.set(tableName, cancelled ? "cancelled" : "failed")
    }
  }

  return statuses
}

export function appendCancelledTableEvents(events: SyncExecuteProgress[]): SyncExecuteProgress[] {
  const running = new Set<string>()
  for (const event of events) {
    if (event.table && event.type === "table-started") running.add(event.table)
    if (event.table && event.type === "table-done") running.delete(event.table)
  }
  if (running.size === 0) return events
  const extra: SyncExecuteProgress[] = [...events]
  for (const table of running) {
    extra.push({ type: "failed", table, error: "Cancelled", step: "cancelled" })
  }
  return extra
}
