import type { SyncExecuteProgress } from "../../types"
import type { ExecState } from "./types"
import type { ExecTableStatus } from "./exec-status"

export interface MetadataTableProgress {
  /** Committed successfully (table-done). */
  committed: number
  /** Applied in open transaction (table-progress without error). */
  applying: number
  failed: number
  pending: number
  total: number
  pct: number
}

/** Truthful metadata table counters for progress bars — not raw table-done events. */
export function countMetadataTableProgress(
  exec: ExecState,
  affectedTables: readonly string[],
  execStatus: Map<string, ExecTableStatus>,
): MetadataTableProgress {
  const total = affectedTables.length
  if (exec.kind === "idle" || total === 0) {
    return { committed: 0, applying: 0, failed: 0, pending: total, total, pct: 0 }
  }

  let committed = 0
  let applying = 0
  let failed = 0
  for (const table of affectedTables) {
    const status = execStatus.get(table)
    if (status === "done") committed++
    else if (status === "applying") applying++
    else if (status === "failed" || status === "cancelled") failed++
  }
  const resolved = committed + failed
  const pct = total > 0 ? Math.min(100, (resolved / total) * 100) : 0
  const pending = Math.max(0, total - committed - applying - failed)
  return { committed, applying, failed, pending, total, pct }
}

export function metadataProgressLabel(progress: MetadataTableProgress, isRunning: boolean): string {
  if (progress.total === 0) return ""
  const parts: string[] = []
  if (progress.committed > 0) parts.push(`${progress.committed} committed`)
  if (progress.applying > 0) parts.push(`${progress.applying} in txn`)
  if (progress.failed > 0) parts.push(`${progress.failed} failed`)
  if (isRunning && progress.pending > 0) parts.push(`${progress.pending} pending`)
  const summary = parts.length > 0 ? parts.join(" · ") : `${progress.committed}/${progress.total} tables`
  return `${summary} · ${Math.round(progress.pct)}%`
}

export function isTerminalExecEvent(event: SyncExecuteProgress): boolean {
  return event.type === "completed" || event.type === "skipped" || event.type === "failed"
}

export function execTerminalSuccess(event: SyncExecuteProgress): boolean {
  if (event.type === "skipped") return true
  if (event.type === "completed") return true
  return false
}
