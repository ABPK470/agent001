/**
 * RunHistory — browse past agent runs for the active thread.
 *
 * Layout follows the *widget container* (grid cell, pop-out window, or
 * narrow screen) via CSS container queries — never the viewport. Click a
 * run to select it for the rest of the workspace.
 */

import { GitBranch, Play, RotateCcw, Square, Undo2 } from "lucide-react"
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react"
import { api } from "../client/index"
import { EmptyState } from "../components/EmptyState"
import { RunStatus } from "../enums"
import { useStore } from "../state/store"
import type { AgentDefinition, Run } from "../types"
import { fmtTokens, statusColor, timeAgo } from "../lib/util"
import { WIDGET_ICONS } from "./widget-icons"

function isLiveStatus(status: Run["status"]): boolean {
  return (
    status === RunStatus.Running
    || status === RunStatus.Pending
    || status === RunStatus.Planning
  )
}

function canResume(status: Run["status"]): boolean {
  return (
    status === RunStatus.Failed
    || status === RunStatus.Cancelled
    || status === RunStatus.Crashed
  )
}

function canRerunOrRollback(status: Run["status"]): boolean {
  return (
    status === RunStatus.Completed
    || status === RunStatus.Failed
    || status === RunStatus.Cancelled
    || status === RunStatus.Crashed
  )
}

function sortRunsNewestFirst(runs: Run[]): Run[] {
  return [...runs].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  )
}

function RunHistoryRow({
  run,
  selected,
  agentLabel,
  rolledBack,
  onSelect,
  onCancel,
  onResume,
  onRerun,
  onRollback,
}: {
  run: Run
  selected: boolean
  agentLabel: string | null
  rolledBack: boolean
  onSelect: () => void
  onCancel: () => void
  onResume: () => void
  onRerun: () => void
  onRollback: () => void
}) {
  const live = isLiveStatus(run.status)

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
            <span
              className="run-history-row__status"
              style={{ color: statusColor(run.status) }}
            >
              {run.status}
            </span>
          </div>
          <div className="run-history-row__meta">
            {agentLabel && (
              <span className="run-history-row__agent">{agentLabel}</span>
            )}
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

      <div
        className="run-history-row__actions"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        {live && (
          <button
            type="button"
            className="run-history-action run-history-action--danger"
            onClick={onCancel}
            title="Cancel"
          >
            <Square size={14} strokeWidth={2.25} />
          </button>
        )}
        {canResume(run.status) && (
          <button
            type="button"
            className="run-history-action"
            onClick={onResume}
            title="Resume from checkpoint"
          >
            <RotateCcw size={14} strokeWidth={2.25} />
          </button>
        )}
        {canRerunOrRollback(run.status) && (
          <button
            type="button"
            className="run-history-action"
            onClick={onRerun}
            title="Re-run with same goal"
          >
            <Play size={14} strokeWidth={2.25} />
          </button>
        )}
        {canRerunOrRollback(run.status) && !rolledBack && (
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
  )
}

export function RunHistory() {
  const rootRef = useRef<HTMLDivElement>(null)
  const runs = useStore((s) => s.runs)
  const activeRunId = useStore((s) => s.activeRunId)
  const setActiveRun = useStore((s) => s.setActiveRun)
  const activeThreadId = useStore((s) => s.activeThreadId)
  const [agents, setAgents] = useState<AgentDefinition[]>([])
  const [rolledBackIds, setRolledBackIds] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    api.listAgents().then(setAgents).catch(() => {})
  }, [])

  const agentById = useMemo(() => {
    const map = new Map<string, string>()
    for (const agent of agents) map.set(agent.id, agent.name)
    return map
  }, [agents])

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
    if (!confirm("Rollback all file changes from this run?")) return
    api.rollbackRun(runId).then(() => {
      setRolledBackIds((prev) => new Set(prev).add(runId))
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
            agentLabel={run.agentId ? (agentById.get(run.agentId) ?? null) : null}
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
