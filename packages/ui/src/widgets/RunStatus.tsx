/**
 * RunStatus — shows current run status, metadata, and progress.
 */

import { Loader2, RotateCcw, Square, Undo2 } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { api } from "../api"
import { useStore } from "../store"
import type { AgentDefinition, RollbackPreview } from "../types"
import { fmtTokens, statusColor, timeAgo } from "../util"

export function RunStatus() {
  const runs = useStore((s) => s.runs)
  const activeRunId = useStore((s) => s.activeRunId)
  const steps = useStore((s) => s.steps)
  const liveUsage = useStore((s) => s.liveUsage)

  const [agents, setAgents] = useState<AgentDefinition[]>([])
  useEffect(() => { api.listAgents().then(setAgents).catch(() => {}) }, [])

  // ── Rollback state (must be before any early returns) ──
  const [rollbackPreview, setRollbackPreview] = useState<RollbackPreview | null>(null)
  const [rollbackLoading, setRollbackLoading] = useState(false)
  const [rollbackResult, setRollbackResult] = useState<string | null>(null)
  const [rolledBack, setRolledBack] = useState(false)

  const run = runs.find((r) => r.id === activeRunId)
  const agentName = run?.agentId ? agents.find((a) => a.id === run.agentId)?.name : null

  const handleRollbackPreview = useCallback(async () => {
    if (!run) return
    setRollbackLoading(true)
    setRollbackResult(null)
    try {
      const preview = await api.previewRollback(run.id)
      setRollbackPreview(preview)
    } catch {
      setRollbackResult("Failed to load preview")
    }
    setRollbackLoading(false)
  }, [run])

  const handleRollbackConfirm = useCallback(async () => {
    if (!run) return
    setRollbackLoading(true)
    try {
      const result = await api.rollbackRun(run.id)
      if (result.failed.length > 0) {
        setRollbackResult(`Rolled back ${result.compensated} effects, ${result.failed.length} failed`)
      } else {
        setRollbackResult(`Rolled back ${result.compensated} effects, ${result.skipped} skipped`)
      }
    } catch {
      setRollbackResult("Rollback failed")
    }
    setRollbackPreview(null)
    setRollbackLoading(false)
    setRolledBack(true)
  }, [run])

  // Reset rolledBack state when switching runs
  useEffect(() => { setRolledBack(false) }, [activeRunId])

  // Auto-dismiss rollback result after 8 seconds
  useEffect(() => {
    if (!rollbackResult) return
    const timer = setTimeout(() => setRollbackResult(null), 8000)
    return () => clearTimeout(timer)
  }, [rollbackResult])

  if (!run) {
    return (
      <div className="flex items-center justify-center h-full text-text-muted text-sm">
        No active run
      </div>
    )
  }

  const isActive = run.status === "running" || run.status === "pending" || run.status === "planning"
  const completedSteps = steps.filter((s) => s.status === "completed").length
  const failedSteps = steps.filter((s) => s.status === "failed").length

  async function handleCancel() {
    if (run) await api.cancelRun(run.id).catch(() => {})
  }

  async function handleResume() {
    if (run) await api.resumeRun(run.id).catch(() => {})
  }

  return (
    <div className="h-full overflow-y-auto flex flex-col gap-3">
      {/* Status badge */}
      <div className="flex items-center gap-2.5">
        <div
          className="w-2.5 h-2.5 rounded-full"
          style={{ background: statusColor(run.status) }}
        />
        <span className="text-base font-semibold uppercase tracking-wide" style={{ color: statusColor(run.status) }}>
          {run.status}
        </span>
        {isActive && (
          <Loader2 size={16} className="text-accent animate-spin ml-auto" />
        )}
      </div>

      {/* Goal */}
      <div>
        <span className="text-[13px] text-text-muted uppercase tracking-wide">Goal</span>
        <p className="text-sm text-text mt-0.5 leading-relaxed">{run.goal}</p>
      </div>

      {/* Metadata grid */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-2.5 text-sm">
        {agentName && (
          <div>
            <span className="text-text-muted text-[13px]">Agent</span>
            <div className="text-accent text-[13px]">{agentName}</div>
          </div>
        )}
        <div>
          <span className="text-text-muted text-[13px]">Run ID</span>
          <div className="text-text-secondary font-mono text-[13px]">{run.id.slice(0, 8)}</div>
        </div>
        <div>
          <span className="text-text-muted text-[13px]">Started</span>
          <div className="text-text-secondary">{timeAgo(run.createdAt)}</div>
        </div>
        <div>
          <span className="text-text-muted text-[13px]">Steps</span>
          <div className="text-text-secondary">
            <span className="text-success">{completedSteps}</span>
            {failedSteps > 0 && <span className="text-error ml-1">/ {failedSteps} failed</span>}
            {` / ${isActive ? steps.length : run.stepCount} total`}
          </div>
        </div>
        {run.parentRunId && (
          <div>
            <span className="text-text-muted text-[13px]">Resumed from</span>
            <div className="text-accent font-mono text-[13px]">{run.parentRunId.slice(0, 8)}</div>
          </div>
        )}
        <div>
          <span className="text-text-muted text-[13px]">Tokens</span>
          <div className="text-text-secondary font-mono text-[13px]">
            {isActive
              ? <>{fmtTokens(liveUsage.totalTokens)} <span className="text-text-muted">({liveUsage.llmCalls} calls)</span></>
              : run.totalTokens > 0
                ? <>{fmtTokens(run.totalTokens)} <span className="text-text-muted">({run.llmCalls} calls)</span></>
                : <span className="text-text-muted">—</span>
            }
          </div>
        </div>
        {(isActive ? liveUsage.promptTokens > 0 : run.promptTokens > 0) && (
          <div>
            <span className="text-text-muted text-[13px]">Prompt / Completion</span>
            <div className="text-text-secondary font-mono text-[13px]">
              {fmtTokens(isActive ? liveUsage.promptTokens : run.promptTokens)}
              {" / "}
              {fmtTokens(isActive ? liveUsage.completionTokens : run.completionTokens)}
            </div>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex gap-2 mt-1">
        {isActive && (
          <button
            className="flex items-center gap-1.5 px-4 py-2 min-h-[44px] text-[13px] text-error bg-error/10 hover:bg-error/20 active:bg-error/25 rounded-lg transition-colors"
            onClick={handleCancel}
          >
            <Square size={13} />
            Cancel
          </button>
        )}
        {(run.status === "failed" || run.status === "cancelled") && (
          <button
            className="flex items-center gap-1.5 px-4 py-2 min-h-[44px] text-[13px] text-accent bg-accent/10 hover:bg-accent/20 active:bg-accent/25 rounded-lg transition-colors"
            onClick={handleResume}
          >
            <RotateCcw size={13} />
            Resume
          </button>
        )}
        {(run.status === "completed" || run.status === "failed" || run.status === "cancelled") && !rolledBack && (
          <button
            className="flex items-center gap-1.5 px-4 py-2 min-h-[44px] text-[13px] text-warning bg-warning/10 hover:bg-warning/20 active:bg-warning/25 rounded-lg transition-colors"
            onClick={handleRollbackPreview}
            disabled={rollbackLoading}
          >
            <Undo2 size={13} />
            {rollbackLoading ? "Loading..." : "Rollback"}
          </button>
        )}
      </div>

      {/* Rollback result */}
      {rollbackResult && (
        <div className="text-[13px] text-text-secondary bg-elevated px-3 py-2 rounded-lg">
          {rollbackResult}
        </div>
      )}

      {/* Rollback preview dialog */}
      {rollbackPreview && (
        <div className="bg-elevated border border-border rounded-lg p-3 space-y-2">
          <div className="text-sm font-semibold text-warning">Rollback Preview</div>
          {rollbackPreview.wouldCompensate.length > 0 && (
            <div>
              <div className="text-[13px] text-success">Will restore ({rollbackPreview.wouldCompensate.length}):</div>
              {rollbackPreview.wouldCompensate.map((e) => (
                <div key={e.effectId} className="text-[11px] text-text-muted font-mono truncate pl-2">
                  {e.kind} {e.target.split("/").pop()}
                </div>
              ))}
            </div>
          )}
          {rollbackPreview.wouldSkip.length > 0 && (
            <div>
              <div className="text-[13px] text-text-muted">Will skip ({rollbackPreview.wouldSkip.length}):</div>
              {rollbackPreview.wouldSkip.slice(0, 5).map((e) => (
                <div key={e.effectId} className="text-[11px] text-text-muted font-mono truncate pl-2">
                  {e.target.split("/").pop()} — {e.reason}
                </div>
              ))}
              {rollbackPreview.wouldSkip.length > 5 && (
                <div className="text-[11px] text-text-muted pl-2">...and {rollbackPreview.wouldSkip.length - 5} more</div>
              )}
            </div>
          )}
          {rollbackPreview.wouldFail.length > 0 && (
            <div>
              <div className="text-[13px] text-error">Would fail ({rollbackPreview.wouldFail.length}) — rollback blocked:</div>
              {rollbackPreview.wouldFail.map((e) => (
                <div key={e.effectId} className="text-[11px] text-error/80 font-mono truncate pl-2">
                  {e.target.split("/").pop()} — {e.reason}
                </div>
              ))}
            </div>
          )}
          <div className="flex gap-2 pt-1">
            {rollbackPreview.wouldFail.length === 0 && rollbackPreview.wouldCompensate.length > 0 && (
              <button
                className="flex items-center gap-1.5 px-3 py-1.5 text-[13px] text-warning bg-warning/10 hover:bg-warning/20 rounded-lg transition-colors"
                onClick={handleRollbackConfirm}
                disabled={rollbackLoading}
              >
                <Undo2 size={12} />
                Confirm Rollback
              </button>
            )}
            <button
              className="px-3 py-1.5 text-[13px] text-text-muted hover:text-text rounded-lg transition-colors"
              onClick={() => setRollbackPreview(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
