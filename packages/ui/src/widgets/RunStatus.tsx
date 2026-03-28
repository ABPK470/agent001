/**
 * RunStatus — shows current run status, metadata, and progress.
 */

import { Loader2, RotateCcw, Square } from "lucide-react"
import { api } from "../api"
import { useStore } from "../store"
import { statusColor, timeAgo } from "../util"

export function RunStatus() {
  const runs = useStore((s) => s.runs)
  const activeRunId = useStore((s) => s.activeRunId)
  const steps = useStore((s) => s.steps)

  const run = runs.find((r) => r.id === activeRunId)

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
            {` / ${run.stepCount} total`}
          </div>
        </div>
        {run.parentRunId && (
          <div>
            <span className="text-text-muted text-[13px]">Resumed from</span>
            <div className="text-accent font-mono text-[13px]">{run.parentRunId.slice(0, 8)}</div>
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
        {run.status === "failed" && (
          <button
            className="flex items-center gap-1.5 px-4 py-2 min-h-[44px] text-[13px] text-accent bg-accent/10 hover:bg-accent/20 active:bg-accent/25 rounded-lg transition-colors"
            onClick={handleResume}
          >
            <RotateCcw size={13} />
            Resume
          </button>
        )}
      </div>
    </div>
  )
}
