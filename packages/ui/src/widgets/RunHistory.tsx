/**
 * RunHistory — browse past agent runs.
 *
 * Click a run to select it (updates other widgets with that run's data).
 * Shows status, goal, time, step count, and inline actions.
 */

import { GitBranch, Play, RotateCcw, Square, Undo2 } from "lucide-react"
import { useEffect, useState } from "react"
import { api } from "../api"
import { useStore } from "../store"
import type { AgentDefinition } from "../types"
import { fmtTokens, statusColor, timeAgo, truncate } from "../util"

export function RunHistory() {
  const runs = useStore((s) => s.runs)
  const activeRunId = useStore((s) => s.activeRunId)
  const setActiveRun = useStore((s) => s.setActiveRun)
  const setSteps = useStore((s) => s.setSteps)
  const setAudit = useStore((s) => s.setAudit)
  const setLogs = useStore((s) => s.setLogs)
  const setTrace = useStore((s) => s.setTrace)
  const [agents, setAgents] = useState<AgentDefinition[]>([])

  // Load agents
  useEffect(() => {
    api.listAgents().then(setAgents).catch(() => {})
  }, [])

  const agentName = (id: string | null) => {
    if (!id) return null
    return agents.find((a) => a.id === id)?.name ?? null
  }

  async function handleSelect(runId: string) {
    setActiveRun(runId)

    // Load run details + trace
    try {
      const [detail, trace] = await Promise.all([
        api.getRun(runId),
        api.getRunTrace(runId),
      ])
      setSteps(detail.data.steps ?? [])
      setAudit(detail.audit)
      setLogs(detail.logs)
      setTrace(trace as import("../types").TraceEntry[])
    } catch {
      // Run might still be in-memory only
    }
  }

  if (runs.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-text-muted text-sm">
        No runs yet
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto space-y-0.5">
      {runs.map((run) => {
        const isActive = run.status === "running" || run.status === "pending" || run.status === "planning"

        return (
        <div
          key={run.id}
          className={`group flex items-center gap-2.5 px-2.5 py-2 min-h-[44px] rounded-lg cursor-pointer transition-colors ${
            run.id === activeRunId
              ? "bg-elevated"
              : "hover:bg-elevated/40"
          }`}
          onClick={() => handleSelect(run.id)}
        >
          {/* Status dot */}
          <div
            className="w-2.5 h-2.5 rounded-full shrink-0"
            style={{ background: statusColor(run.status) }}
          />

          {/* Info */}
          <div className="flex-1 min-w-0">
            <div className="text-sm text-text truncate">{truncate(run.goal, 50)}</div>
            <div className="flex items-center gap-2 text-[13px] text-text-muted mt-0.5">
              {agentName(run.agentId) && (
                <>
                  <span className="text-accent text-[11px]">{agentName(run.agentId)}</span>
                  <span className="text-text-muted/40">·</span>
                </>
              )}
              <span>{timeAgo(run.createdAt)}</span>
              <span className="text-text-muted/40">·</span>
              <span>{run.stepCount} steps</span>
              {run.totalTokens > 0 && (
                <>
                  <span className="text-text-muted/40">·</span>
                  <span className="text-text-muted font-mono">{fmtTokens(run.totalTokens)} tk</span>
                </>
              )}
              {run.parentRunId && (
                <>
                  <span className="text-text-muted/40">·</span>
                  <GitBranch size={13} className="text-accent" />
                  <span className="text-accent">resumed</span>
                </>
              )}
            </div>
          </div>

          {/* Inline actions (visible on hover) */}
          <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
            {isActive && (
              <button
                className="p-1.5 text-error/70 hover:text-error rounded transition-colors"
                onClick={(e) => { e.stopPropagation(); api.cancelRun(run.id).catch(() => {}) }}
                title="Cancel"
              >
                <Square size={13} />
              </button>
            )}
            {run.status === "failed" && (
              <button
                className="p-1.5 text-accent/70 hover:text-accent rounded transition-colors"
                onClick={(e) => {
                  e.stopPropagation()
                  api.resumeRun(run.id).then((r) => {
                    if (r.runId) setActiveRun(r.runId)
                  }).catch(() => {})
                }}
                title="Resume from checkpoint"
              >
                <RotateCcw size={13} />
              </button>
            )}
            {(run.status === "completed" || run.status === "failed") && (
              <button
                className="p-1.5 text-accent/70 hover:text-accent rounded transition-colors"
                onClick={(e) => {
                  e.stopPropagation()
                  api.rerunRun(run.id).then((r) => {
                    if (r.runId) setActiveRun(r.runId)
                  }).catch(() => {})
                }}
                title="Re-run with same goal"
              >
                <Play size={13} />
              </button>
            )}
            {(run.status === "completed" || run.status === "failed") && (
              <button
                className="p-1.5 text-warning/70 hover:text-warning rounded transition-colors"
                onClick={(e) => {
                  e.stopPropagation()
                  if (confirm("Rollback all file changes from this run?")) {
                    api.rollbackRun(run.id).catch(() => {})
                  }
                }}
                title="Rollback file changes"
              >
                <Undo2 size={13} />
              </button>
            )}
          </div>

          {/* Status text */}
          <span
            className="text-[13px] font-medium shrink-0"
            style={{ color: statusColor(run.status) }}
          >
            {run.status}
          </span>
        </div>
        )
      })}
    </div>
  )
}
