/**
 * RunStatus — shows current run status, metadata, and progress.
 */

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
      <div className="flex items-center justify-center h-full text-text-muted text-[11px]">
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
    <div className="flex flex-col gap-3">
      {/* Status badge */}
      <div className="flex items-center gap-2">
        <div
          className="w-2.5 h-2.5 rounded-full"
          style={{ background: statusColor(run.status) }}
        />
        <span className="text-sm font-semibold uppercase tracking-wide" style={{ color: statusColor(run.status) }}>
          {run.status}
        </span>
        {isActive && (
          <span className="text-[10px] text-accent animate-pulse ml-auto">●</span>
        )}
      </div>

      {/* Goal */}
      <div>
        <span className="text-[10px] text-text-muted uppercase">Goal</span>
        <p className="text-xs text-text mt-0.5">{run.goal}</p>
      </div>

      {/* Metadata grid */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-[11px]">
        <div>
          <span className="text-text-muted">Run ID</span>
          <div className="text-text font-mono text-[10px]">{run.id.slice(0, 8)}</div>
        </div>
        <div>
          <span className="text-text-muted">Started</span>
          <div className="text-text">{timeAgo(run.createdAt)}</div>
        </div>
        <div>
          <span className="text-text-muted">Steps</span>
          <div className="text-text">
            <span className="text-success">{completedSteps}</span>
            {failedSteps > 0 && <span className="text-error ml-1">/ {failedSteps} failed</span>}
            {` / ${run.stepCount} total`}
          </div>
        </div>
        {run.parentRunId && (
          <div>
            <span className="text-text-muted">Resumed from</span>
            <div className="text-accent font-mono text-[10px]">{run.parentRunId.slice(0, 8)}</div>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex gap-2 mt-1">
        {isActive && (
          <button
            className="px-3 py-1 text-[10px] border border-error/40 text-error rounded hover:bg-error/10 transition-colors"
            onClick={handleCancel}
          >
            Cancel
          </button>
        )}
        {run.status === "failed" && (
          <button
            className="px-3 py-1 text-[10px] border border-accent/40 text-accent rounded hover:bg-accent/10 transition-colors"
            onClick={handleResume}
          >
            Resume
          </button>
        )}
      </div>
    </div>
  )
}
