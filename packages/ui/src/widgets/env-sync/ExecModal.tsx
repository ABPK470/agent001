import { CheckCircle2, Loader2, Ship, X, XCircle } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"

import type { SyncEnvironment, SyncExecuteProgress, SyncPlan } from "../../types"
import { tableHasMovement } from "../../types"
import { DIFF } from "./constants"
import { buildExecPreflightChecks, execPreflightBlocked, execPreflightBlockReason } from "./exec-preflight"
import { buildExecTableStatus } from "./exec-status"
import { buildDeployProgress, syncFlowStepLabel } from "./exec-deploy-status"
import { countMetadataTableProgress, metadataProgressLabel } from "./exec-progress"
import { execAuditLogEvents } from "./exec-log-events"
import type { ExecState } from "./types"

const STALL_WARN_MS = 45_000

function formatElapsed(ms: number): string {
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s`
  return `${Math.floor(sec / 60)}m ${sec % 60}s`
}

export function ExecModal({ exec, plan, execPlanId, tgtEnv, onConfirm, onCancel, onClose }: {
  exec: ExecState
  plan: SyncPlan | null
  execPlanId: string | null
  tgtEnv: SyncEnvironment | null
  onConfirm: () => void
  onCancel: () => void
  onClose: () => void
}) {
  const totals = plan?.totals ?? { insert: 0, update: 0, delete: 0, unchanged: 0, conflicts: 0, tablesCount: 0 }
  const planId = plan?.planId ?? execPlanId ?? ""
  const isIdle = exec.kind === "idle" && !!plan
  const isRunning = exec.kind === "running"
  const isDone = exec.kind === "done"
  const skipped = isDone && !!exec.skipped
  const success = isDone && exec.success && !skipped
  const failed = isDone && !exec.success && !skipped
  const cancelled = isDone && !exec.success && !skipped && exec.error?.toLowerCase().includes("cancel")

  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!isRunning) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [isRunning])

  const affectedTables = useMemo(
    () => plan ? plan.tables.filter((table) => tableHasMovement(table)).map((table) => table.table) : [],
    [plan],
  )
  const total = affectedTables.length
  const execStatus = useMemo(() => buildExecTableStatus(exec), [exec])
  const metaProgress = useMemo(
    () => countMetadataTableProgress(exec, affectedTables, execStatus),
    [exec, affectedTables, execStatus],
  )
  const done = metaProgress.committed
  const pct = metaProgress.pct
  const deployProgress = useMemo(
    () => (exec.kind === "idle" ? { total: 0, done: 0, failed: 0, skipped: 0 } : buildDeployProgress(exec.events, plan)),
    [exec, plan],
  )
  const deployResolved = deployProgress.done + deployProgress.failed + deployProgress.skipped
  const deployPct =
    deployProgress.total > 0 ? Math.min(100, (deployResolved / deployProgress.total) * 100) : 0
  const events: SyncExecuteProgress[] = exec.kind !== "idle" ? exec.events : []
  const logEvents = useMemo(() => execAuditLogEvents(events), [events])
  const latestEvent = events.length > 0 ? events[events.length - 1] : null
  const currentStep = latestEvent
    ? (latestEvent.step ? syncFlowStepLabel(plan, latestEvent.step) : (latestEvent.message ?? latestEvent.type))
    : isRunning ? "connecting" : null

  const elapsedMs = exec.kind === "running" ? now - exec.startedAt : 0
  const sinceLastEventMs = exec.kind === "running" ? now - exec.lastEventAt : 0
  const stalled = isRunning && sinceLastEventMs >= STALL_WARN_MS

  const preflightChecks = useMemo(() => (plan ? buildExecPreflightChecks(plan) : []), [plan])
  const preflightBlocked = plan ? execPreflightBlocked(plan) : false
  const preflightBlockReason = plan ? execPreflightBlockReason(plan) : null

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
      : cancelled ? "Sync Cancelled"
        : skipped ? "Sync Skipped"
          : success ? "Sync Complete"
            : "Sync Failed"

  const headerIcon = isIdle ? <Ship size={20} className="text-accent" />
    : isRunning ? <Loader2 size={20} className="animate-spin text-accent" />
      : cancelled ? <XCircle size={20} className="text-text-muted" />
        : skipped ? <CheckCircle2 size={20} className="text-warning" />
          : success ? <CheckCircle2 size={20} style={{ color: DIFF.ins }} />
            : <XCircle size={20} style={{ color: DIFF.del }} />

  function handleHeaderClose() {
    if (isRunning) onCancel()
    onClose()
  }

  return createPortal(
    <div
      className="exec-modal-overlay fixed inset-0 z-[200] flex items-center justify-center"
      onClick={isRunning ? undefined : onClose}
    >
      <div
        className={[
          "bg-surface flex flex-col shadow-2xl overflow-hidden rounded-xl sm:rounded-2xl transition-[width,height] duration-300",
          isIdle ? "exec-modal-shell--idle" : "exec-modal-shell--live",
        ].join(" ")}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 sm:px-6 pt-4 sm:pt-5 pb-3 sm:pb-4 border-b border-border-subtle shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            {headerIcon}
            <h3 className="text-lg font-semibold text-text truncate">{title}</h3>
            {!isIdle && (
              <span className="text-sm text-text-muted font-mono tabular-nums shrink-0">
                {total > 0 ? (
                  <>
                    meta {done}/{total}
                    {deployProgress.total > 0 ? (
                      <> · deploy {deployResolved}/{deployProgress.total}</>
                    ) : null}
                  </>
                ) : (
                  formatElapsed(elapsedMs)
                )}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={handleHeaderClose}
            className="text-text-muted hover:text-text p-1.5 rounded-lg hover:bg-overlay-3 transition-colors shrink-0"
            title={isRunning ? "Cancel and close" : "Close"}
          >
            <X size={18} />
          </button>
        </div>

        {isIdle && (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex-1 overflow-y-auto">
              <div className="px-4 sm:px-5 pt-4 pb-3 text-center">
                <p className="text-sm text-text-muted">
                  Apply changes to <span className="font-semibold text-text">{tgtEnv?.displayName ?? plan?.target ?? "target"}</span>
                </p>
              </div>

              <div className="mx-4 sm:mx-5 rounded-lg border border-border-subtle bg-overlay-1 px-4 py-3">
                <div className="flex items-center justify-center gap-5 font-mono text-sm tabular-nums">
                  {stats.map((stat) => (
                    <div key={stat.label} className="text-center">
                      <div className="text-lg font-semibold" style={{ color: stat.color }}>{stat.n}</div>
                      <div className="text-xs text-text-muted">{stat.label}</div>
                    </div>
                  ))}
                  <div className="text-center">
                    <div className="text-lg font-semibold text-text-muted">{totals.tablesCount}</div>
                    <div className="text-xs text-text-muted">tables w/ changes</div>
                  </div>
                </div>
              </div>

              {preflightChecks.length > 0 && (
                <div className="mx-4 sm:mx-5 mt-3 rounded-lg border border-border-subtle bg-overlay-1 px-3 py-2.5 space-y-1.5">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">
                    Execute gates
                  </p>
                  {preflightChecks.map((check) => (
                    <div key={check.id} className="flex items-start gap-2 text-xs">
                      {check.passed ? (
                        <CheckCircle2 size={14} className="shrink-0 mt-0.5" style={{ color: DIFF.ins }} />
                      ) : (
                        <XCircle size={14} className="shrink-0 mt-0.5" style={{ color: DIFF.del }} />
                      )}
                      <div className="min-w-0">
                        <div className={check.passed ? "text-text-muted" : "text-text"}>{check.label}</div>
                        {!check.passed && check.detail && (
                          <div className="text-text-muted/80 mt-0.5 leading-snug">{check.detail}</div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {preflightBlocked && preflightBlockReason && (
                <div className="mx-4 sm:mx-5 mt-3 rounded-lg border border-error/25 bg-error/8 px-3 py-2 text-xs leading-relaxed" style={{ color: DIFF.del }}>
                  Execute blocked: {preflightBlockReason}
                </div>
              )}

              <div className="px-4 sm:px-5 pt-3 pb-4 text-center space-y-1">
                <p className="text-[11px] text-text-muted/50 font-mono">
                  metadata = one target transaction (rollback on error)
                </p>
                <p className="text-[11px] text-text-muted/40 font-mono">
                  deploy steps run after commit · {planId.slice(0, 8)}
                </p>
              </div>
            </div>

            <div className="shrink-0 border-t border-border-subtle px-4 sm:px-5 py-4 flex gap-2">
              <button type="button" onClick={onClose} className="flex-1 h-9 text-sm text-text-muted hover:text-text rounded-lg border border-border-subtle hover:bg-elevated transition-colors">
                Cancel
              </button>
              <button type="button" onClick={onConfirm} disabled={preflightBlocked} className="flex-1 h-9 text-sm text-text bg-accent hover:bg-accent-hover rounded-lg flex items-center justify-center gap-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                <Ship size={14} /> Execute
              </button>
            </div>
          </div>
        )}

        {!isIdle && (
          <div className="flex flex-col min-h-0 flex-1">
            <div className="shrink-0 px-4 sm:px-6 pt-3 pb-2 space-y-2">
              <div className="rounded-lg border border-border-subtle bg-overlay-1 px-4 py-3">
                <div className="flex items-baseline justify-between gap-3 mb-2.5">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">
                    {total > 0 ? "Metadata tables" : "Execution progress"}
                  </span>
                  <span className="text-xs font-mono tabular-nums text-text-muted shrink-0">
                    {total > 0 ? (
                      <>{metadataProgressLabel(metaProgress, isRunning)}</>
                    ) : isRunning ? (
                      <>{formatElapsed(elapsedMs)}</>
                    ) : success ? (
                      <>complete</>
                    ) : (
                      <>failed</>
                    )}
                  </span>
                </div>
                <div className="exec-modal-progress__bar">
                  {total > 0 ? (
                    <div
                      className="exec-modal-progress__fill"
                      style={{ width: `${pct}%`, background: failed ? DIFF.del : isDone && success ? DIFF.ins : "var(--accent)" }}
                    />
                  ) : isRunning ? (
                    <div className="exec-modal-progress__indeterminate" />
                  ) : (
                    <div
                      className="exec-modal-progress__fill"
                      style={{ width: "100%", background: failed && !cancelled ? DIFF.del : cancelled ? "var(--color-text-muted)" : DIFF.ins }}
                    />
                  )}
                </div>
                {deployProgress.total > 0 && (
                  <>
                    <div className="flex items-baseline justify-between gap-3 mt-3 mb-2.5">
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">
                        Deploy pipeline
                      </span>
                      <span className="text-xs font-mono tabular-nums text-text-muted shrink-0">
                        {deployResolved}/{deployProgress.total} steps · {Math.round(deployPct)}%
                        {deployProgress.failed > 0 ? ` · ${deployProgress.failed} failed` : ""}
                        {deployProgress.skipped > 0 ? ` · ${deployProgress.skipped} skipped` : ""}
                      </span>
                    </div>
                    <div className="exec-modal-progress__bar">
                      <div
                        className="exec-modal-progress__fill"
                        style={{
                          width: `${deployPct}%`,
                          background:
                            deployProgress.failed > 0
                              ? DIFF.del
                              : deployResolved >= deployProgress.total && success
                                ? DIFF.ins
                                : "var(--accent)"
                        }}
                      />
                    </div>
                  </>
                )}
                {currentStep && (
                  <p className="mt-2.5 text-xs font-mono text-text truncate" title={currentStep}>
                    {isRunning && <span className="text-accent/70">▸ </span>}
                    {currentStep}
                  </p>
                )}
              </div>

              {stalled && (
                <div className="rounded-lg border border-warning/25 bg-warning/8 px-3 py-2 text-xs text-warning leading-relaxed">
                  No progress for {formatElapsed(sinceLastEventMs)} — likely waiting on the database
                  (catalog check or a long query). You can cancel; the server stops when the current step finishes or times out.
                </div>
              )}
            </div>

            {total > 0 && (
              <div className="px-4 sm:px-6 pb-3 shrink-0">
                <div className="flex flex-wrap gap-x-3 gap-y-1.5 text-sm font-mono">
                  {affectedTables.map((tableName) => {
                    const status = execStatus.get(tableName)
                    const short = tableName.split(".").pop() ?? tableName
                    return (
                      <span key={tableName} className="flex items-center gap-1.5">
                        {status === "running" && <Loader2 size={11} className="animate-spin text-accent shrink-0" />}
                        {status === "applying" && <Loader2 size={11} className="animate-spin text-warning shrink-0" />}
                        {status === "done" && <CheckCircle2 size={11} style={{ color: DIFF.ins }} className="shrink-0" />}
                        {status === "failed" && <XCircle size={11} style={{ color: DIFF.del }} className="shrink-0" />}
                        {status === "cancelled" && <XCircle size={11} className="shrink-0 text-text-muted/50" />}
                        {!status && <span className="w-[11px] h-[11px] rounded-full border border-border shrink-0" />}
                        <span
                          className={`${
                            status === "done"
                              ? "text-text-muted/40"
                              : status === "applying"
                                ? "text-warning/90"
                                : status === "failed"
                                  ? ""
                                  : "text-text"
                          }`}
                          style={status === "failed" ? { color: DIFF.del } : undefined}
                          title={status === "applying" ? "Applied in transaction — not committed until metadata step succeeds" : undefined}
                        >
                          {short}
                        </span>
                      </span>
                    )
                  })}
                </div>
              </div>
            )}

            <div className="exec-modal-log-wrap">
              <div className="exec-modal-log__header" aria-hidden>
                <span>Step</span>
                <span>Table</span>
                <span>Rows</span>
                <span>Detail</span>
              </div>
              <div ref={logRef} className="exec-modal-log flex-1 min-h-0 font-mono text-sm">
              {logEvents.map((event, index) => {
                const label = event.step ? syncFlowStepLabel(plan, event.step) : event.type
                const isDeploy = event.type === "deploy-step"
                const isInTxn = event.type === "table-progress" && !event.error
                const detail = event.type === "failed" || event.deployStatus === "failed"
                  ? (event.error ?? event.message ?? null)
                  : event.type === "skipped" || event.deployStatus === "skipped"
                    ? (event.message ?? "skipped")
                    : event.error
                      ? event.error
                      : event.message && event.message !== label
                        ? event.message
                        : null
                const rows = typeof event.rowsApplied === "number" ? `${event.rowsApplied}` : null
                const detailIsError = !!(event.error || event.type === "failed" || event.deployStatus === "failed")
                const detailIsSkipped = event.type === "skipped" || event.deployStatus === "skipped"
                const stepClass =
                  detailIsSkipped
                    ? "text-warning/90"
                    : isInTxn
                      ? "text-warning/80"
                    : isDeploy && event.deployStatus === "skipped"
                    ? "text-text-muted/60"
                    : isDeploy
                      ? "text-accent/80"
                      : event.type === "step"
                        ? "text-accent/70"
                        : event.type === "failed"
                          ? "text-warning"
                          : "text-text-muted/50"
                return (
                  <div key={index} className="exec-modal-log__line">
                    <span
                      className={`exec-modal-log__step text-xs ${stepClass}`}
                      title={label}
                    >
                      {label}
                    </span>
                    <span className="exec-modal-log__table text-xs text-accent/90" title={event.table}>
                      {event.table ? event.table.split(".").pop() : <span className="exec-modal-log__empty">—</span>}
                    </span>
                    <span className="exec-modal-log__rows text-xs text-text-muted">
                      {rows ? <>{rows}</> : <span className="exec-modal-log__empty">—</span>}
                    </span>
                    <span
                      className={`exec-modal-log__message text-xs ${detailIsError ? "" : detailIsSkipped ? "text-warning/90" : event.type === "step" ? "text-text-muted/70" : "text-text/90"}`}
                      style={detailIsError ? { color: DIFF.del } : undefined}
                    >
                      {detail ?? <span className="exec-modal-log__empty">—</span>}
                    </span>
                  </div>
                )
              })}
              {exec.kind === "done" && skipped && (exec.message ?? exec.error) && (
                <div className="mt-3 px-3 py-2.5 rounded-lg bg-warning/10 border border-warning/20 whitespace-pre-wrap break-words text-sm leading-relaxed text-warning">
                  {exec.message ?? exec.error}
                </div>
              )}
              {exec.kind === "done" && failed && exec.error && (
                <div className="mt-3 px-3 py-2.5 rounded-lg bg-error/10 border border-error/20 whitespace-pre-wrap break-words text-sm leading-relaxed" style={{ color: cancelled ? "var(--color-text-muted)" : DIFF.del }}>
                  {exec.error}
                </div>
              )}
              </div>
            </div>

            <div className="px-4 sm:px-6 py-3 border-t border-border-subtle shrink-0 flex items-center justify-between gap-3">
              <span className="text-xs text-text-muted/50 font-mono truncate">{planId.slice(0, 8)}</span>
              <div className="flex items-center gap-2 shrink-0">
                {isRunning && (
                  <button
                    type="button"
                    onClick={onCancel}
                    className="h-8 px-4 text-sm text-warning hover:text-warning rounded-lg border border-warning/30 hover:bg-warning/10 transition-colors"
                  >
                    Cancel
                  </button>
                )}
                {(isDone || !isRunning) && (
                  <button type="button" onClick={onClose} className="h-8 px-4 text-sm text-text-muted hover:text-text rounded-lg border border-border-subtle hover:bg-elevated transition-colors">
                    Close
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}
