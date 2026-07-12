import type { SyncExecuteProgress } from "../../types"
import type { ExecState } from "./types"

export type ExecTableStatus = "running" | "applying" | "done" | "failed" | "cancelled"

function metadataSyncFailed(events: readonly SyncExecuteProgress[]): boolean {
  return events.some(
    (event) =>
      event.type === "failed"
      && (event.step === "metadataSync" || event.step === "execute" || event.error?.includes("metadataSync")),
  )
}

/** Derive per-table execute indicators for plan rows and the exec modal. */
export function buildExecTableStatus(exec: ExecState): Map<string, ExecTableStatus> {
  const statuses = new Map<string, ExecTableStatus>()
  if (exec.kind === "idle") return statuses

  for (const event of exec.events) {
    if (!event.table) continue
    if (event.type === "table-started") statuses.set(event.table, "running")
    if (event.type === "table-progress") {
      statuses.set(event.table, event.error ? "failed" : "applying")
    }
    if (event.type === "table-done") statuses.set(event.table, "done")
  }

  if (exec.kind === "running") return statuses

  const cancelled = exec.kind === "done" && exec.error?.toLowerCase().includes("cancel")
  const rolledBack = metadataSyncFailed(exec.events)

  if (exec.kind === "done" && !exec.success) {
    if (rolledBack) {
      for (const [tableName, state] of statuses) {
        if (state === "done" || state === "applying") statuses.set(tableName, "failed")
      }
    }
    for (const event of exec.events) {
      if (event.type === "failed" && !event.table) {
        for (const [tableName, state] of statuses) {
          if (state === "running" || state === "applying") {
            statuses.set(tableName, cancelled ? "cancelled" : "failed")
          }
        }
      }
    }
    for (const [tableName, state] of statuses) {
      if (state === "running" || state === "applying") {
        statuses.set(tableName, cancelled ? "cancelled" : "failed")
      }
    }
  }

  return statuses
}

export function appendCancelledTableEvents(events: SyncExecuteProgress[]): SyncExecuteProgress[] {
  const inFlight = new Set<string>()
  for (const event of events) {
    if (!event.table) continue
    if (event.type === "table-started") inFlight.add(event.table)
    if (event.type === "table-done") inFlight.delete(event.table)
    if (event.type === "table-progress" && !event.error) inFlight.add(event.table)
  }
  if (inFlight.size === 0) return events
  const extra: SyncExecuteProgress[] = [...events]
  for (const table of inFlight) {
    extra.push({ type: "failed", table, error: "Cancelled", step: "cancelled" })
  }
  return extra
}
