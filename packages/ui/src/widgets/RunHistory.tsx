/**
 * RunHistory — browse past agent runs for the active thread.
 *
 * Layout follows the *widget container* (grid cell, pop-out window, or
 * narrow screen) via CSS container queries — never the viewport. Click a
 * run to select it for the rest of the workspace.
 */

import { GitBranch, Play, RotateCcw, Square, Undo2 } from "lucide-react"
import { useMemo, useRef, useState, type KeyboardEvent } from "react"
import { api } from "../client/index"
import { EmptyState } from "../components/EmptyState"
import { useStore } from "../state/store"
import type { Run } from "../types"
import {
  canCancelRun,
  canResumeRun,
  canRollbackRun,
  isTerminalRunStatus,
} from "../lib/run-actions"
import { fmtTokens, statusColor, timeAgo } from "../lib/util"
import { WIDGET_ICONS } from "./widget-icons"

function sortRunsNewestFirst(runs: Run[]): Run[] {
  return [...runs].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  )
}

function RunHistoryRow({
  run,
  selected,
  rolledBack,
  onSelect,
  onCancel,
  onResume,
  onRerun,
  onRollback,
}: {
  run: Run
  selected: boolean
  rolledBack: boolean
  onSelect: () => void
  onCancel: () => void
  onResume: () => void
  onRerun: () => void
  onRollback: () => void
}) {
  const showCancel = canCancelRun(run.status)
  const showResume = canResumeRun(run.status, run.hasCheckpoint)
  const showRerun = isTerminalRunStatus(run.status)
  const showRollback = canRollbackRun(run.status, {
    rollbackAvailable: run.rollbackAvailable,
    alreadyRolledBack: rolledBack,
  })

  function onRowKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault()
      onSelect()
    }
  }

  return (
    <div
      role="button"
      tabIndex={0}
      className={`run-history-row${selected ? " run-history-row--selected" : ""}`}
      onClick={onSelect}
      onKeyDown={onRowKeyDown}
    >
      <div className="run-history-row__main">
        <span
          className="run-history-row__dot"
          style={{
            background: statusColor(run.status),
            boxShadow: `0 0 8px ${statusColor(run.status)}66`,
          }}
          aria-hidden
        />
        <div className="run-history-row__body">
          <div className="run-history-row__title">
            <span className="run-history-row__goal" title={run.goal}>{run.goal}</span>
          </div>
          <div className="run-history-row__meta">
            <span>{timeAgo(run.createdAt)}</span>
            <span className="run-history-row__meta-steps">{run.stepCount} steps</span>
            {run.totalTokens > 0 && (
              <span className="run-history-row__meta-tokens font-mono">
                {fmtTokens(run.totalTokens)} tk
              </span>
            )}
            {run.parentRunId && (
              <span className="run-history-row__resumed">
                <GitBranch size={12} aria-hidden />
                resumed
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Status + actions share one vertical center (not the title baseline). */}
      <div className="run-history-row__trail">
        <span
          className="run-history-row__status"
          style={{ color: statusColor(run.status) }}
        >
          {run.status}
        </span>
        <div
          className="run-history-row__actions"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          {showCancel && (
            <button
              type="button"
              className="run-history-action run-history-action--danger"
              onClick={onCancel}
              title="Cancel"
            >
              <Square size={14} strokeWidth={2.25} />
            </button>
          )}
          {showResume && (
            <button
              type="button"
              className="run-history-action"
              onClick={onResume}
              title="Resume from checkpoint"
            >
              <RotateCcw size={14} strokeWidth={2.25} />
            </button>
          )}
          {showRerun && (
            <button
              type="button"
              className="run-history-action"
              onClick={onRerun}
              title="Re-run with same goal"
            >
              <Play size={14} strokeWidth={2.25} />
            </button>
          )}
          {showRollback && (
            <button
              type="button"
              className="run-history-action run-history-action--warning"
              onClick={onRollback}
              title="Rollback file changes"
            >
              <Undo2 size={14} strokeWidth={2.25} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

export function RunHistory() {
  const rootRef = useRef<HTMLDivElement>(null)
  const runs = useStore((s) => s.runs)
  const activeRunId = useStore((s) => s.activeRunId)
  const setActiveRun = useStore((s) => s.setActiveRun)
  const upsertRun = useStore((s) => s.upsertRun)
  const activeThreadId = useStore((s) => s.activeThreadId)
  const [rolledBackIds, setRolledBackIds] = useState<Set<string>>(() => new Set())

  const threadRuns = useMemo(() => {
    if (!activeThreadId) return []
    return sortRunsNewestFirst(
      runs.filter((r) => r.threadId === activeThreadId),
    )
  }, [runs, activeThreadId])

  function selectRun(runId: string) {
    setActiveRun(runId)
  }

  function cancelRun(runId: string) {
    api.cancelRun(runId).catch(() => {})
  }

  function resumeRun(runId: string) {
    api.resumeRun(runId).then((r) => {
      if (r.runId) setActiveRun(r.runId)
    }).catch(() => {})
  }

  function rerunRun(runId: string) {
    api.rerunRun(runId).then((r) => {
      if (r.runId) setActiveRun(r.runId)
    }).catch(() => {})
  }

  function rollbackRun(runId: string) {
    if (!confirm("Rollback uncompensated file effects from this run?")) return
    api.rollbackRun(runId).then((result) => {
      if (result.failed.length > 0) {
        upsertRun({ id: runId, rollbackAvailable: true })
        return
      }
      setRolledBackIds((prev) => new Set(prev).add(runId))
      upsertRun({ id: runId, rollbackAvailable: false })
    }).catch(() => {})
  }

  if (!activeThreadId) {
    return (
      <div ref={rootRef} className="run-history-widget">
        <EmptyState icon={WIDGET_ICONS["thread-nav"]} message="Select a thread" />
      </div>
    )
  }

  if (threadRuns.length === 0) {
    return (
      <div ref={rootRef} className="run-history-widget">
        <EmptyState icon={WIDGET_ICONS["run-history"]} message="No runs in this thread" />
      </div>
    )
  }

  return (
    <div ref={rootRef} className="run-history-widget">
      <div className="run-history-list">
        {threadRuns.map((run) => (
          <RunHistoryRow
            key={run.id}
            run={run}
            selected={run.id === activeRunId}
            rolledBack={rolledBackIds.has(run.id)}
            onSelect={() => selectRun(run.id)}
            onCancel={() => cancelRun(run.id)}
            onResume={() => resumeRun(run.id)}
            onRerun={() => rerunRun(run.id)}
            onRollback={() => rollbackRun(run.id)}
          />
        ))}
      </div>
    </div>
  )
}
