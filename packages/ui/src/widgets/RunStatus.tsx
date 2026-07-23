/**
 * RunStatus — truthful status for the active run: capability-gated actions,
 * errors/answers, workspace apply, and effect rollback only when there is work.
 */

import { Loader2, RotateCcw, Square, Undo2 } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { api } from "../client/index"
import { EmptyState } from "../components/EmptyState"
import { ToastStack, useWidgetToasts } from "../components/useWidgetToasts"
import { RunStatus as RunStatusEnum } from "../enums"
import { useContainerSize } from "../hooks/useContainerSize"
import {
  canCancelRun,
  canConfirmRollback,
  canResumeRun,
  canRollbackRun,
  isLiveRunStatus,
} from "../lib/run-actions"
import { fmtTokens, statusColor, timeAgo } from "../lib/util"
import { useStore } from "../state/store"
import type { RollbackPreview, TraceEntry, WorkspaceDiff } from "../types"
import { WIDGET_ICONS } from "./widget-icons"

type PlannerDecisionTrace = Extract<TraceEntry, { kind: "planner-decision" }>

const PANEL = "rounded-xl border border-border-subtle bg-panel-2"

export function RunStatus() {
  const runs = useStore((s) => s.runs)
  const activeRunId = useStore((s) => s.activeRunId)
  const steps = useStore((s) => s.steps)
  const liveUsage = useStore((s) => s.liveUsage)
  const trace = useStore((s) => s.trace)
  const upsertRun = useStore((s) => s.upsertRun)
  const setActiveRun = useStore((s) => s.setActiveRun)
  const { toasts, dismissToast, notifyError, notify, notifyInfo } = useWidgetToasts()

  const [rollbackPreview, setRollbackPreview] = useState<RollbackPreview | null>(null)
  const [rollbackLoading, setRollbackLoading] = useState(false)
  const [rollbackResult, setRollbackResult] = useState<string | null>(null)
  const [rolledBack, setRolledBack] = useState(false)
  const [workspaceDiff, setWorkspaceDiff] = useState<WorkspaceDiff | null>(null)
  const [workspaceLoading, setWorkspaceLoading] = useState(false)
  const [workspaceResult, setWorkspaceResult] = useState<string | null>(null)
  const workspaceBusyRef = useRef(false)
  const autoLoadedKeyRef = useRef<string | null>(null)

  const run = runs.find((r) => r.id === activeRunId)

  const rootRef = useRef<HTMLDivElement>(null)
  const { width: rootWidth } = useContainerSize(rootRef)
  const compact = rootWidth > 0 && rootWidth < 420

  useEffect(() => {
    setRolledBack(false)
    setRollbackPreview(null)
    setRollbackResult(null)
    setWorkspaceResult(null)
  }, [activeRunId])

  useEffect(() => {
    if (!rollbackResult) return
    const timer = setTimeout(() => setRollbackResult(null), 8000)
    return () => clearTimeout(timer)
  }, [rollbackResult])

  // Keep capability flags fresh when the selected run is terminal.
  useEffect(() => {
    if (!run) return
    if (isLiveRunStatus(run.status)) return
    if (run.hasCheckpoint != null && run.rollbackAvailable != null) return
    let cancelled = false
    api.getRun(run.id).then((detail) => {
      if (cancelled) return
      upsertRun({
        id: run.id,
        hasCheckpoint: detail.hasCheckpoint,
        rollbackAvailable: detail.rollbackAvailable,
        error: detail.error,
        answer: detail.answer,
        completedAt: detail.completedAt,
      })
    }).catch((err: unknown) => { console.error("[mia]", err) })
    return () => { cancelled = true }
  }, [run?.id, run?.status, run?.hasCheckpoint, run?.rollbackAvailable, upsertRun])

  const refreshWorkspaceDiff = useCallback(async (targetRunId?: string) => {
    const runId = targetRunId ?? run?.id
    if (!runId || workspaceBusyRef.current) return
    workspaceBusyRef.current = true
    setWorkspaceLoading(true)
    setWorkspaceResult(null)
    try {
      const diff = await api.getRunWorkspaceDiff(runId)
      setWorkspaceDiff(diff)
      upsertRun({ id: runId, pendingWorkspaceChanges: diff.total })
      autoLoadedKeyRef.current = `${runId}:${diff.total}`
    } catch {
      setWorkspaceDiff(null)
      upsertRun({ id: runId, pendingWorkspaceChanges: 0 })
    } finally {
      workspaceBusyRef.current = false
      setWorkspaceLoading(false)
    }
  }, [run?.id, upsertRun])

  const handleApplyWorkspaceDiff = useCallback(async () => {
    if (!run || workspaceBusyRef.current) return
    workspaceBusyRef.current = true
    setWorkspaceLoading(true)
    setWorkspaceResult(null)
    try {
      const result = await api.applyRunWorkspaceDiff(run.id)
      const total = result.applied.added + result.applied.modified + result.applied.deleted
      setWorkspaceResult(`Applied ${total} file changes to repository workspace`)
      setWorkspaceDiff(null)
      upsertRun({ id: run.id, pendingWorkspaceChanges: 0 })
      autoLoadedKeyRef.current = null
      notify(`Applied ${total} workspace change(s)`)
    } catch (e) {
      setWorkspaceResult("Failed to apply workspace changes")
      notifyError(e instanceof Error ? e.message : "Failed to apply workspace changes")
    } finally {
      workspaceBusyRef.current = false
      setWorkspaceLoading(false)
    }
  }, [run, upsertRun, notify, notifyError])

  const handleRollbackPreview = useCallback(async () => {
    if (!run) return
    setRollbackLoading(true)
    setRollbackResult(null)
    try {
      const preview = await api.previewRollback(run.id)
      setRollbackPreview(preview)
      const available = canConfirmRollback(preview)
      upsertRun({ id: run.id, rollbackAvailable: available })
      if (!available) {
        setRollbackResult(
          preview.wouldFail.length > 0
            ? "Rollback blocked — see details below"
            : "Nothing left to roll back",
        )
      }
    } catch (e) {
      setRollbackResult("Failed to load rollback preview")
      notifyError(e instanceof Error ? e.message : "Failed to load rollback preview")
    }
    setRollbackLoading(false)
  }, [run, upsertRun, notifyError])

  const handleRollbackConfirm = useCallback(async () => {
    if (!run) return
    setRollbackLoading(true)
    try {
      const result = await api.rollbackRun(run.id)
      if (result.failed.length > 0) {
        setRollbackResult(`Rolled back ${result.compensated} effects, ${result.failed.length} failed`)
        notifyError(`Rollback partially failed (${result.failed.length})`)
        // Do not hide the action — work may remain.
        upsertRun({ id: run.id, rollbackAvailable: true })
      } else if (result.compensated === 0) {
        setRollbackResult("Nothing to roll back")
        setRolledBack(true)
        upsertRun({ id: run.id, rollbackAvailable: false })
      } else {
        setRollbackResult(`Rolled back ${result.compensated} effects${result.skipped ? `, ${result.skipped} skipped` : ""}`)
        setRolledBack(true)
        upsertRun({ id: run.id, rollbackAvailable: false })
        notify(`Rolled back ${result.compensated} effect(s)`)
      }
    } catch (e) {
      setRollbackResult("Rollback failed")
      notifyError(e instanceof Error ? e.message : "Rollback failed")
    }
    setRollbackPreview(null)
    setRollbackLoading(false)
  }, [run, upsertRun, notify, notifyError])

  useEffect(() => {
    if (!run) {
      autoLoadedKeyRef.current = null
      return
    }
    if ((run.pendingWorkspaceChanges ?? 0) <= 0) {
      setWorkspaceDiff(null)
      autoLoadedKeyRef.current = null
      return
    }
    const key = `${run.id}:${run.pendingWorkspaceChanges ?? 0}`
    if (autoLoadedKeyRef.current === key) return
    refreshWorkspaceDiff(run.id).catch((err: unknown) => { console.error("[mia]", err) })
  }, [run?.id, run?.pendingWorkspaceChanges, refreshWorkspaceDiff])

  const handleCancel = useCallback(async () => {
    if (!run) return
    try {
      await api.cancelRun(run.id)
      notifyInfo("Cancel requested")
    } catch (e) {
      notifyError(e instanceof Error ? e.message : "Cancel failed")
    }
  }, [run, notifyInfo, notifyError])

  const handleResume = useCallback(async () => {
    if (!run) return
    try {
      const { runId } = await api.resumeRun(run.id)
      if (runId) {
        setActiveRun(runId)
        notifyInfo("Resumed from checkpoint")
      }
    } catch (e) {
      notifyError(e instanceof Error ? e.message : "Resume failed — no checkpoint?")
    }
  }, [run, setActiveRun, notifyInfo, notifyError])

  if (!run) {
    return (
      <div className="flex h-full flex-col">
        <EmptyState icon={WIDGET_ICONS["run-status"]} message="No active run" />
      </div>
    )
  }

  const isActive = isLiveRunStatus(run.status)
  const showCancel = canCancelRun(run.status)
  const showResume = canResumeRun(run.status, run.hasCheckpoint)
  const showRollback = canRollbackRun(run.status, {
    rollbackAvailable: run.rollbackAvailable,
    alreadyRolledBack: rolledBack,
  })
  const pendingWorkspace = workspaceDiff?.total ?? run.pendingWorkspaceChanges ?? 0
  const showWorkspace = pendingWorkspace > 0 || workspaceLoading || !!workspaceResult

  const completedSteps = steps.filter((s) => s.status === RunStatusEnum.Completed).length
  const failedSteps = steps.filter((s) => s.status === RunStatusEnum.Failed).length
  const latestPlannerDecision = [...trace].reverse().find(
    (entry): entry is PlannerDecisionTrace => entry.kind === "planner-decision",
  )
  type SubagentModeTrace = Extract<TraceEntry, { kind: "planner-delegation-decision" }>
  const latestSubagentMode = [...trace].reverse().find(
    (entry): entry is SubagentModeTrace => entry.kind === "planner-delegation-decision",
  )
  const subagentModeLabel =
    latestSubagentMode?.executionMode === "parallel"
      ? "Parallel"
      : latestSubagentMode?.executionMode === "serial"
        ? "Serial"
        : latestSubagentMode?.executionMode === "guided"
          ? "Guided"
          : latestSubagentMode?.executionMode === "stop"
            ? "Blocked"
            : latestSubagentMode
              ? latestSubagentMode.shouldDelegate
                ? "Parallel"
                : "Serial"
              : null

  return (
    <div ref={rootRef} className="relative flex h-full flex-col gap-3 overflow-y-auto">
      <ToastStack toasts={toasts} onDismiss={dismissToast} />

      <div className="flex items-center gap-2.5">
        <div
          className="h-2.5 w-2.5 rounded-full"
          style={{ background: statusColor(run.status) }}
        />
        <span
          className="text-base font-semibold uppercase tracking-wide"
          style={{ color: statusColor(run.status) }}
        >
          {run.status.replace(/_/g, " ")}
        </span>
        {rolledBack && (
          <span className="rounded-md bg-warning/15 px-1.5 py-0.5 text-[11px] font-medium text-warning">
            rolled back
          </span>
        )}
        {isActive && <Loader2 size={16} className="ml-auto animate-spin text-accent" />}
      </div>

      <div>
        <span className="text-[13px] uppercase tracking-wide text-text-muted">Goal</span>
        <p className="mt-0.5 text-sm leading-relaxed text-text">{run.goal}</p>
      </div>

      {run.error && (
        <div className={`${PANEL} border-error/30 px-3 py-2.5`}>
          <div className="text-[12px] uppercase tracking-wide text-error">Error</div>
          <p className="mt-1 text-sm leading-snug text-error/90 whitespace-pre-wrap break-words">
            {run.error}
          </p>
        </div>
      )}

      {run.status === RunStatusEnum.Completed && run.answer && (
        <div className={`${PANEL} px-3 py-2.5`}>
          <div className="text-[12px] uppercase tracking-wide text-text-muted">Answer</div>
          <p className="mt-1 text-sm leading-relaxed text-text-secondary whitespace-pre-wrap break-words">
            {run.answer}
          </p>
        </div>
      )}

      {run.status === RunStatusEnum.WaitingForApproval && (
        <div className={`${PANEL} border-warning/30 px-3 py-2.5 text-sm text-text`}>
          Waiting for tool approval — cancel here, or approve/deny from the chat prompt.
        </div>
      )}

      <div className={`grid gap-x-4 gap-y-2.5 text-sm ${compact ? "grid-cols-1" : "grid-cols-2"}`}>
        <div>
          <span className="text-[13px] text-text-muted">Run ID</span>
          <div className="font-mono text-[13px] text-text-secondary">{run.id.slice(0, 8)}</div>
        </div>
        <div>
          <span className="text-[13px] text-text-muted">Started</span>
          <div className="text-text-secondary">{timeAgo(run.createdAt)}</div>
        </div>
        {run.completedAt && (
          <div>
            <span className="text-[13px] text-text-muted">Finished</span>
            <div className="text-text-secondary">{timeAgo(run.completedAt)}</div>
          </div>
        )}
        <div>
          <span className="text-[13px] text-text-muted">Steps</span>
          <div className="text-text-secondary">
            <span className="text-success">{completedSteps}</span>
            {failedSteps > 0 && <span className="ml-1 text-error">/ {failedSteps} failed</span>}
            {` / ${isActive ? steps.length : run.stepCount} total`}
          </div>
        </div>
        {run.parentRunId && (
          <div>
            <span className="text-[13px] text-text-muted">Resumed from</span>
            <div className="font-mono text-[13px] text-accent">{run.parentRunId.slice(0, 8)}</div>
          </div>
        )}
        <div>
          <span className="text-[13px] text-text-muted">Checkpoint</span>
          <div className="text-text-secondary">
            {run.hasCheckpoint == null ? "…" : run.hasCheckpoint ? "available" : "none"}
          </div>
        </div>
        <div>
          <span className="text-[13px] text-text-muted">Tokens</span>
          <div className="font-mono text-[13px] text-text-secondary">
            {isActive
              ? <>{fmtTokens(liveUsage.totalTokens)} <span className="text-text-muted">({liveUsage.llmCalls} calls)</span></>
              : run.totalTokens > 0
                ? <>{fmtTokens(run.totalTokens)} <span className="text-text-muted">({run.llmCalls} calls)</span></>
                : <span className="text-text-muted">—</span>}
          </div>
        </div>
        {(isActive ? liveUsage.promptTokens > 0 : run.promptTokens > 0) && (
          <div>
            <span className="text-[13px] text-text-muted">Prompt / Completion</span>
            <div className="font-mono text-[13px] text-text-secondary">
              {fmtTokens(isActive ? liveUsage.promptTokens : run.promptTokens)}
              {" / "}
              {fmtTokens(isActive ? liveUsage.completionTokens : run.completionTokens)}
            </div>
          </div>
        )}
      </div>

      {latestPlannerDecision && (
        <div className="rounded-xl border border-success/20 bg-success/[0.06] p-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-[13px] uppercase tracking-wide text-text-muted">Execution route</div>
              <div className="mt-0.5 text-sm text-text-secondary">
                {latestPlannerDecision.route ?? (latestPlannerDecision.shouldPlan ? "planner" : "direct")}
              </div>
            </div>
            <div className={`rounded-full px-2 py-1 text-xs font-medium ${latestPlannerDecision.shouldPlan ? "bg-success/10 text-success" : "bg-overlay-2 text-text-secondary"}`}>
              {latestPlannerDecision.shouldPlan ? "Planner" : "Direct"}
            </div>
          </div>
          <div className="mt-2 text-[13px] text-text-secondary">{latestPlannerDecision.reason}</div>
          {subagentModeLabel && latestPlannerDecision.shouldPlan && (
            <div className="mt-2 flex items-center justify-between gap-3 border-t border-success/15 pt-2">
              <div>
                <div className="text-[13px] uppercase tracking-wide text-text-muted">Subagent mode</div>
                <div className="mt-0.5 text-sm text-text-secondary">{subagentModeLabel}</div>
              </div>
              {latestSubagentMode && (
                <div className="text-[12px] text-text-muted">
                  utility {latestSubagentMode.utilityScore.toFixed(2)}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {(showCancel || showResume || showRollback) && (
        <div className={`mt-1 flex gap-2 ${compact ? "flex-wrap" : ""}`}>
          {showCancel && (
            <button
              type="button"
              className="flex min-h-[44px] items-center gap-1.5 rounded-lg bg-error/10 px-4 py-2 text-[13px] text-error transition-colors hover:bg-error/20"
              onClick={() => void handleCancel()}
            >
              <Square size={13} />
              Cancel
            </button>
          )}
          {showResume && (
            <button
              type="button"
              className="flex min-h-[44px] items-center gap-1.5 rounded-lg bg-accent/10 px-4 py-2 text-[13px] text-accent transition-colors hover:bg-accent/20"
              onClick={() => void handleResume()}
              title="Resume from saved checkpoint"
            >
              <RotateCcw size={13} />
              Resume
            </button>
          )}
          {showRollback && (
            <button
              type="button"
              className="flex min-h-[44px] items-center gap-1.5 rounded-lg bg-warning/10 px-4 py-2 text-[13px] text-warning transition-colors hover:bg-warning/20 disabled:opacity-40"
              onClick={() => void handleRollbackPreview()}
              disabled={rollbackLoading}
              title="Roll back uncompensated file effects"
            >
              <Undo2 size={13} />
              {rollbackLoading ? "Loading…" : "Rollback"}
            </button>
          )}
        </div>
      )}

      {rollbackResult && (
        <div className={`${PANEL} px-3 py-2 text-[13px] text-text-secondary`}>
          {rollbackResult}
        </div>
      )}

      {rollbackPreview && (
        <div className={`${PANEL} space-y-2 p-3`}>
          <div className="text-sm font-semibold text-warning">Rollback preview</div>
          {rollbackPreview.wouldCompensate.length > 0 && (
            <div>
              <div className="text-[13px] text-success">
                Will restore ({rollbackPreview.wouldCompensate.length}):
              </div>
              {rollbackPreview.wouldCompensate.map((e) => (
                <div key={e.effectId} className="truncate pl-2 font-mono text-[11px] text-text-muted">
                  {e.kind} {e.target.split("/").pop()}
                </div>
              ))}
            </div>
          )}
          {rollbackPreview.wouldSkip.length > 0 && (
            <div>
              <div className="text-[13px] text-text-muted">
                Will skip ({rollbackPreview.wouldSkip.length}):
              </div>
              {rollbackPreview.wouldSkip.slice(0, 5).map((e) => (
                <div key={e.effectId} className="truncate pl-2 font-mono text-[11px] text-text-muted">
                  {e.target.split("/").pop()} — {e.reason}
                </div>
              ))}
            </div>
          )}
          {rollbackPreview.wouldFail.length > 0 && (
            <div>
              <div className="text-[13px] text-error">
                Would fail ({rollbackPreview.wouldFail.length}) — blocked:
              </div>
              {rollbackPreview.wouldFail.map((e) => (
                <div key={e.effectId} className="truncate pl-2 font-mono text-[11px] text-error/80">
                  {e.target.split("/").pop()} — {e.reason}
                </div>
              ))}
            </div>
          )}
          <div className="flex gap-2 pt-1">
            {canConfirmRollback(rollbackPreview) && (
              <button
                type="button"
                className="flex items-center gap-1.5 rounded-lg bg-warning/10 px-3 py-1.5 text-[13px] text-warning transition-colors hover:bg-warning/20"
                onClick={() => void handleRollbackConfirm()}
                disabled={rollbackLoading}
              >
                <Undo2 size={12} />
                Confirm rollback
              </button>
            )}
            <button
              type="button"
              className="rounded-lg px-3 py-1.5 text-[13px] text-text-muted transition-colors hover:text-text"
              onClick={() => setRollbackPreview(null)}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {showWorkspace && (
        <div className={`${PANEL} space-y-2 p-3`}>
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm font-semibold text-text">Workspace changes</div>
            <div className="text-[12px] text-text-muted">
              {pendingWorkspace > 0 ? `${pendingWorkspace} pending` : "none"}
            </div>
          </div>
          {pendingWorkspace > 0 && (
            <div className="text-[12px] text-text-secondary">
              Isolated codegen edits — apply to merge into the repo workspace.
            </div>
          )}
          {workspaceDiff && workspaceDiff.total > 0 && (
            <div className="space-y-1 font-mono text-[12px] text-text-secondary">
              {workspaceDiff.added.length > 0 && (
                <div>+ added: {workspaceDiff.added.slice(0, 4).join(", ")}{workspaceDiff.added.length > 4 ? ` +${workspaceDiff.added.length - 4}` : ""}</div>
              )}
              {workspaceDiff.modified.length > 0 && (
                <div>~ modified: {workspaceDiff.modified.slice(0, 4).join(", ")}{workspaceDiff.modified.length > 4 ? ` +${workspaceDiff.modified.length - 4}` : ""}</div>
              )}
              {workspaceDiff.deleted.length > 0 && (
                <div>- deleted: {workspaceDiff.deleted.slice(0, 4).join(", ")}{workspaceDiff.deleted.length > 4 ? ` +${workspaceDiff.deleted.length - 4}` : ""}</div>
              )}
            </div>
          )}
          <div className="flex gap-2 pt-1">
            <button
              type="button"
              className="rounded-lg bg-accent/10 px-3 py-1.5 text-[13px] text-accent transition-colors hover:bg-accent/20"
              onClick={() => void refreshWorkspaceDiff(run.id)}
              disabled={workspaceLoading}
            >
              {workspaceLoading ? "Loading…" : "Refresh"}
            </button>
            {pendingWorkspace > 0 && (
              <button
                type="button"
                className="rounded-lg bg-success/10 px-3 py-1.5 text-[13px] text-success transition-colors hover:bg-success/20"
                onClick={() => void handleApplyWorkspaceDiff()}
                disabled={workspaceLoading}
              >
                Apply changes
              </button>
            )}
          </div>
          {workspaceResult && (
            <div className="text-[12px] text-text-secondary">{workspaceResult}</div>
          )}
        </div>
      )}
    </div>
  )
}
