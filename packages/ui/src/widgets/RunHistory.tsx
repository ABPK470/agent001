/**
 * RunHistory — browse past agent runs.
 *
 * Click a run to select it (updates other widgets with that run's data).
 * Shows status, goal, time, and step count.
 */

import { GitBranch } from "lucide-react"
import { useEffect } from "react"
import { api } from "../api"
import { useStore } from "../store"
import { statusColor, timeAgo, truncate } from "../util"

export function RunHistory() {
  const runs = useStore((s) => s.runs)
  const activeRunId = useStore((s) => s.activeRunId)
  const setActiveRun = useStore((s) => s.setActiveRun)
  const setRuns = useStore((s) => s.setRuns)
  const setSteps = useStore((s) => s.setSteps)
  const setAudit = useStore((s) => s.setAudit)
  const setLogs = useStore((s) => s.setLogs)

  // Refresh run list periodically
  useEffect(() => {
    const interval = setInterval(() => {
      api.listRuns().then(setRuns).catch(() => {})
    }, 5000)
    return () => clearInterval(interval)
  }, [setRuns])

  async function handleSelect(runId: string) {
    setActiveRun(runId)

    // Load run details
    try {
      const detail = await api.getRun(runId)
      setSteps(detail.data.steps ?? [])
      setAudit(detail.audit)
      setLogs(detail.logs)
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
    <div className="space-y-0.5">
      {runs.map((run) => (
        <div
          key={run.id}
          className={`flex items-center gap-2.5 px-2.5 py-2 rounded-lg cursor-pointer transition-colors ${
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
              <span>{timeAgo(run.createdAt)}</span>
              <span className="text-text-muted/40">·</span>
              <span>{run.stepCount} steps</span>
              {run.parentRunId && (
                <>
                  <span className="text-text-muted/40">·</span>
                  <GitBranch size={13} className="text-accent" />
                  <span className="text-accent">resumed</span>
                </>
              )}
            </div>
          </div>

          {/* Status text */}
          <span
            className="text-[13px] font-medium shrink-0"
            style={{ color: statusColor(run.status) }}
          >
            {run.status}
          </span>
        </div>
      ))}
    </div>
  )
}
