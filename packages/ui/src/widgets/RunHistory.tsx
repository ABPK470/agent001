/**
 * RunHistory — browse past agent runs.
 *
 * Click a run to select it (updates other widgets with that run's data).
 * Shows status, goal, time, step count, and inline actions.
 */

import { GitBranch, Play, RotateCcw, Square, Undo2 } from "lucide-react"
import { useEffect, useState } from "react"
import { api } from "../api"
import { RunStatus } from "../enums"
import { useStore } from "../store"
import type { AgentDefinition } from "../types"
import { fmtTokens, statusColor, timeAgo, truncate } from "../util"

export function RunHistory() {
  const runs = useStore((s) => s.runs)
  const activeRunId = useStore((s) => s.activeRunId)
  const setActiveRun = useStore((s) => s.setActiveRun)
  const setRuns = useStore((s) => s.setRuns)
  const [agents, setAgents] = useState<AgentDefinition[]>([])
  const [rolledBackIds, setRolledBackIds] = useState<Set<string>>(new Set())
  // "session" — just this chat (current cookie sid). "all" — every run owned
  // by this UPN across every browser/device. Sessions are still grouped per
  // login: a UPN can have many sids if they signed in from multiple places.
  const [scope, setScope] = useState<"session" | "all">("all")
  // Load agents
  useEffect(() => {
    api.listAgents().then(setAgents).catch(() => {})
  }, [])

  useEffect(() => {
    api.listRuns({ scope }).then(setRuns).catch(() => {})
  }, [scope, setRuns])

  const agentName = (id: string | null) => {
    if (!id) return null
    return agents.find((a) => a.id === id)?.name ?? null
  }

  async function handleSelect(runId: string) {
    setActiveRun(runId)
  }

  if (runs.length === 0) {
    return (
      <div className="flex flex-col h-full">
        <ScopeToggle scope={scope} onChange={setScope} />
        <div className="flex-1 flex items-center justify-center text-text-muted text-sm">
          {scope === "session" ? "No runs in this chat yet" : "No runs yet"}
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <ScopeToggle scope={scope} onChange={setScope} />
      <div className="flex-1 overflow-y-auto space-y-0.5">
      {runs.map((run) => {
        const isActive = run.status === RunStatus.Running || run.status === RunStatus.Pending || run.status === RunStatus.Planning

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
            className="w-2.5 h-2.5 rounded-full shrink-0 ring-2 ring-border"
            style={{
              background: statusColor(run.status),
              boxShadow: `0 0 8px ${statusColor(run.status)}66`,
            }}
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
          <div className="flex items-center gap-1.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
            {isActive && (
              <button
                className="p-1.5 text-error/80 hover:text-error hover:bg-error/10 rounded-md ring-1 ring-border hover:ring-error/30 transition-colors"
                onClick={(e) => { e.stopPropagation(); api.cancelRun(run.id).catch(() => {}) }}
                title="Cancel"
              >
                <Square size={14} strokeWidth={2.25} />
              </button>
            )}
            {(run.status === RunStatus.Failed || run.status === RunStatus.Cancelled) && (
              <button
                className="p-1.5 text-accent/80 hover:text-accent hover:bg-accent/10 rounded-md ring-1 ring-border hover:ring-accent/30 transition-colors"
                onClick={(e) => {
                  e.stopPropagation()
                  api.resumeRun(run.id).then((r) => {
                    if (r.runId) setActiveRun(r.runId)
                  }).catch(() => {})
                }}
                title="Resume from checkpoint"
              >
                <RotateCcw size={14} strokeWidth={2.25} />
              </button>
            )}
            {(run.status === RunStatus.Completed || run.status === RunStatus.Failed || run.status === RunStatus.Cancelled) && (
              <button
                className="p-1.5 text-accent/80 hover:text-accent hover:bg-accent/10 rounded-md ring-1 ring-border hover:ring-accent/30 transition-colors"
                onClick={(e) => {
                  e.stopPropagation()
                  api.rerunRun(run.id).then((r) => {
                    if (r.runId) setActiveRun(r.runId)
                  }).catch(() => {})
                }}
                title="Re-run with same goal"
              >
                <Play size={14} strokeWidth={2.25} />
              </button>
            )}
            {(run.status === RunStatus.Completed || run.status === RunStatus.Failed || run.status === RunStatus.Cancelled) && !rolledBackIds.has(run.id) && (              <button
                className="p-1.5 text-warning/80 hover:text-warning hover:bg-warning/10 rounded-md ring-1 ring-border hover:ring-warning/30 transition-colors"
                onClick={(e) => {
                  e.stopPropagation()
                  if (confirm("Rollback all file changes from this run?")) {
                    api.rollbackRun(run.id).then(() => {
                      setRolledBackIds((prev) => new Set(prev).add(run.id))
                    }).catch(() => {})
                  }
                }}
                title="Rollback file changes"
              >
                <Undo2 size={14} strokeWidth={2.25} />
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
    </div>
  )
}

function ScopeToggle({ scope, onChange }: { scope: "session" | "all"; onChange: (s: "session" | "all") => void }) {
  return (
    <div className="flex items-center gap-0.5 mb-2 p-0.5 rounded-md ring-1 ring-border bg-elevated/40 self-start">
      {(["session", "all"] as const).map((s) => (
        <button
          key={s}
          onClick={() => onChange(s)}
          className={`px-2 py-0.5 text-[11px] rounded transition-colors ${
            scope === s ? "bg-accent/15 text-accent" : "text-text-muted hover:text-text"
          }`}
          title={s === "session" ? "Runs from this chat thread (current login)" : "Every run you own across all sessions"}
        >
          {s === "session" ? "This chat" : "All my runs"}
        </button>
      ))}
    </div>
  )
}
