import { CheckCircle2, Loader2, Ship, X, XCircle } from "lucide-react"
import { useEffect, useMemo, useRef } from "react"
import { createPortal } from "react-dom"

import type { SyncEnvironment, SyncExecuteProgress, SyncPlan } from "../../types"
import { DIFF } from "./constants"
import type { ExecState } from "./types"

export function ExecModal({ exec, plan, execPlanId, tgtEnv, onConfirm, onClose }: {
  exec: ExecState
  plan: SyncPlan | null
  execPlanId: string | null
  tgtEnv: SyncEnvironment | null
  onConfirm: () => void
  onClose: () => void
}) {
  const totals = plan?.totals ?? { insert: 0, update: 0, delete: 0, unchanged: 0, conflicts: 0, tablesCount: 0 }
  const planId = plan?.planId ?? execPlanId ?? ""
  const isIdle = exec.kind === "idle" && !!plan
  const isRunning = exec.kind === "running"
  const isDone = exec.kind === "done"
  const success = isDone && exec.success
  const failed = isDone && !exec.success

  const affectedTables = useMemo(
    () => plan ? plan.tables.filter((table) => table.counts.insert + table.counts.update + table.counts.delete > 0).map((table) => table.table) : [],
    [plan],
  )
  const total = affectedTables.length
  const done = useMemo(
    () => exec.kind === "idle" ? 0 : new Set(exec.events.filter((event) => event.type === "table-done").map((event) => event.table)).size,
    [exec],
  )
  const pct = total > 0 ? Math.min(100, (done / total) * 100) : 0
  const events: SyncExecuteProgress[] = exec.kind !== "idle" ? exec.events : []

  const execStatus = useMemo(() => {
    const statuses = new Map<string, "running" | "done" | "failed">()
    if (exec.kind === "idle") return statuses
    for (const event of exec.events) {
      if (event.table) {
        if (event.type === "table-started") statuses.set(event.table, "running")
        if (event.type === "table-done") statuses.set(event.table, "done")
      }
      if (event.type === "failed") {
        for (const [tableName, state] of statuses) {
          if (state === "running") statuses.set(tableName, "failed")
        }
      }
    }
    return statuses
  }, [exec])

  const stats = [
    { n: totals.insert, label: "insert", color: DIFF.ins },
    { n: totals.update, label: "update", color: DIFF.upd },
    { n: totals.delete, label: "delete", color: DIFF.del },
  ].filter((stat) => stat.n > 0)

  const logRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [exec])

  const title = isIdle ? "Execute Sync"
    : isRunning ? "Executing…"
      : success ? "Sync Complete"
        : "Sync Failed"

  const headerIcon = isIdle ? <Ship size={20} className="text-accent" />
    : isRunning ? <Loader2 size={20} className="animate-spin text-accent" />
      : success ? <CheckCircle2 size={20} style={{ color: DIFF.ins }} />
        : <XCircle size={20} style={{ color: DIFF.del }} />

  return createPortal(
    <div className="fixed inset-0 z-[200] bg-scrim flex items-center justify-center p-2 sm:p-4" onClick={isRunning ? undefined : onClose}>
      <div
        className={`bg-surface flex flex-col shadow-2xl overflow-hidden w-full rounded-xl sm:rounded-2xl transition-all duration-300 ${isIdle ? "h-auto max-h-full" : "h-full sm:h-[85vh]"}`}
        style={{ maxWidth: isIdle ? "24rem" : "48rem" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 pt-5 pb-4 border-b border-border-subtle shrink-0">
          <div className="flex items-center gap-2.5">
            {headerIcon}
            <h3 className="text-lg font-semibold text-text">{title}</h3>
            {!isIdle && <span className="text-sm text-text-muted font-mono tabular-nums">{done}/{total}</span>}
          </div>
          {!isRunning && (
            <button onClick={onClose} className="text-text-muted hover:text-text p-1.5 rounded-lg hover:bg-overlay-3 transition-colors"><X size={18} /></button>
          )}
        </div>

        {isIdle && (
          <>
            <div className="px-5 pt-4 pb-3 text-center">
              <p className="text-sm text-text-muted">
                Apply changes to <span className="font-semibold text-text">{tgtEnv?.displayName ?? plan?.target ?? "target"}</span>
              </p>
            </div>

            <div className="mx-5 rounded-lg border border-border-subtle bg-overlay-1 px-4 py-3">
              <div className="flex items-center justify-center gap-5 font-mono text-sm tabular-nums">
                {stats.map((stat) => (
                  <div key={stat.label} className="text-center">
                    <div className="text-lg font-semibold" style={{ color: stat.color }}>{stat.n}</div>
                    <div className="text-xs text-text-muted">{stat.label}</div>
                  </div>
                ))}
                <div className="text-center">
                  <div className="text-lg font-semibold text-text-muted">{totals.tablesCount}</div>
                  <div className="text-xs text-text-muted">tables</div>
                </div>
              </div>
            </div>

            <div className="px-5 pt-3 pb-1.5 text-center">
              <p className="text-[11px] text-text-muted/50 font-mono">
                single txn · rollback on error · {planId.slice(0, 8)}
              </p>
            </div>

            <div className="px-5 pb-5 pt-3 flex gap-2">
              <button onClick={onClose} className="flex-1 h-9 text-sm text-text-muted hover:text-text rounded-lg border border-border-subtle hover:bg-elevated transition-colors">
                Cancel
              </button>
              <button onClick={onConfirm} className="flex-1 h-9 text-sm text-text bg-accent hover:bg-accent-hover rounded-lg flex items-center justify-center gap-1.5 transition-colors">
                <Ship size={14} /> Execute
              </button>
            </div>
          </>
        )}

        {!isIdle && (
          <div className="flex flex-col min-h-0 flex-1">
            <div className="px-5 py-2.5 shrink-0">
              <div className="h-1.5 bg-elevated rounded-full overflow-hidden">
                <div className="h-full rounded-full transition-all duration-300" style={{ width: `${pct}%`, background: failed ? DIFF.del : "var(--color-accent)" }} />
              </div>
            </div>

            <div className="px-5 pb-3 shrink-0">
              <div className="flex flex-wrap gap-x-3 gap-y-1.5 text-sm font-mono">
                {affectedTables.map((tableName) => {
                  const status = execStatus.get(tableName)
                  const short = tableName.split(".").pop() ?? tableName
                  return (
                    <span key={tableName} className="flex items-center gap-1.5">
                      {status === "running" && <Loader2 size={11} className="animate-spin text-accent" />}
                      {status === "done" && <CheckCircle2 size={11} style={{ color: DIFF.ins }} />}
                      {status === "failed" && <XCircle size={11} style={{ color: DIFF.del }} />}
                      {!status && <span className="w-[11px] h-[11px] rounded-full border border-border" />}
                      <span className={status === "done" ? "text-text-muted/40" : status === "failed" ? "" : "text-text"} style={status === "failed" ? { color: DIFF.del } : undefined}>{short}</span>
                    </span>
                  )
                })}
              </div>
            </div>

            <div ref={logRef} className="flex-1 overflow-y-auto min-h-0 border-t border-border-subtle">
              <div className="font-mono text-sm px-5 py-3 space-y-0.5">
                {events.map((event, index) => (
                  <div key={index} className="flex items-baseline gap-2 min-w-0">
                    <span className={`text-xs w-28 shrink-0 ${event.type === "step" ? "text-accent/60" : "text-text-muted/40"}`}>
                      {event.type === "step" ? (event.step ?? "step") : event.type}
                    </span>
                    {event.table && <span className="text-accent shrink-0">{event.table.split(".").pop()}</span>}
                    {typeof event.rowsApplied === "number" && <span className="text-text-muted tabular-nums shrink-0">{event.rowsApplied} rows</span>}
                    {event.type === "step" && event.message && <span className="text-text-muted/60 break-all min-w-0">{event.message}</span>}
                    {event.type !== "step" && event.message && <span className="text-text break-all min-w-0">{event.message}</span>}
                    {event.error && event.type !== "failed" && <span className="break-all min-w-0" style={{ color: DIFF.del }}>{event.error}</span>}
                  </div>
                ))}
                {exec.kind === "done" && exec.error && (
                  <div className="mt-2 px-3 py-2 rounded-lg bg-error/10 border border-error/20 whitespace-pre-wrap break-all text-sm" style={{ color: DIFF.del }}>
                    {exec.error}
                  </div>
                )}
              </div>
            </div>

            {isDone && (
              <div className="px-5 py-3 border-t border-border-subtle shrink-0 flex items-center justify-between">
                <span className="text-xs text-text-muted/50 font-mono">{planId.slice(0, 8)}</span>
                <button onClick={onClose} className="h-8 px-4 text-sm text-text-muted hover:text-text rounded-lg border border-border-subtle hover:bg-elevated transition-colors">
                  Close
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}