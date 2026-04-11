/**
 * RunStatus — shows current run status, metadata, and progress.
 */

import { Loader2, RotateCcw, Square, Undo2 } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { api } from "../api"
import { useStore } from "../store"
import type { AgentDefinition, RollbackPreview, TraceEntry, WorkspaceDiff } from "../types"
import { fmtTokens, statusColor, timeAgo } from "../util"

type CompatibilityTrace = Extract<TraceEntry, { kind: "planner-repair-compatibility" }>

export function RunStatus() {
  const runs = useStore((s) => s.runs)
  const activeRunId = useStore((s) => s.activeRunId)
  const steps = useStore((s) => s.steps)
  const liveUsage = useStore((s) => s.liveUsage)
  const trace = useStore((s) => s.trace)

  const [agents, setAgents] = useState<AgentDefinition[]>([])
  useEffect(() => { api.listAgents().then(setAgents).catch(() => {}) }, [])

  // ── Rollback state (must be before any early returns) ──
  const [rollbackPreview, setRollbackPreview] = useState<RollbackPreview | null>(null)
  const [rollbackLoading, setRollbackLoading] = useState(false)
  const [rollbackResult, setRollbackResult] = useState<string | null>(null)
  const [rolledBack, setRolledBack] = useState(false)
  const [workspaceDiff, setWorkspaceDiff] = useState<WorkspaceDiff | null>(null)
  const [workspaceLoading, setWorkspaceLoading] = useState(false)
  const [workspaceResult, setWorkspaceResult] = useState<string | null>(null)
  const workspaceBusyRef = useRef(false)
  const autoLoadedKeyRef = useRef<string | null>(null)
  const upsertRun = useStore((s) => s.upsertRun)

  const run = runs.find((r) => r.id === activeRunId)
  const agentName = run?.agentId ? agents.find((a) => a.id === run.agentId)?.name : null

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
    } catch {
      setWorkspaceResult("Failed to apply workspace changes")
    } finally {
      workspaceBusyRef.current = false
      setWorkspaceLoading(false)
    }
  }, [run, upsertRun])

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
    refreshWorkspaceDiff(run.id).catch(() => {})
  }, [run?.id, run?.pendingWorkspaceChanges, refreshWorkspaceDiff])

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
  const latestCompatibility = [...trace].reverse().find((entry): entry is CompatibilityTrace => entry.kind === "planner-repair-compatibility")

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

      {latestCompatibility && (
        <div className="rounded-xl border border-[#F97316]/20 bg-[#F97316]/[0.06] p-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-[13px] text-text-muted uppercase tracking-wide">Planner Compatibility</div>
              <div className="text-sm text-text-secondary mt-0.5">
                mode {latestCompatibility.mode} · active {latestCompatibility.activePath}
              </div>
            </div>
            <div className={`text-xs font-medium px-2 py-1 rounded-full ${latestCompatibility.diverged ? "text-warning bg-warning/10" : "text-success bg-success/10"}`}>
              {latestCompatibility.diverged ? "Diverged" : "Aligned"}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-2 mt-3 text-[13px] text-text-secondary">
            <div>
              <span className="text-text-muted">Score</span>
              <div className="font-mono mt-0.5">
                {(latestCompatibility.divergenceScore ?? latestCompatibility.reasons.length)}/{latestCompatibility.divergenceThreshold ?? "?"}
              </div>
            </div>
            <div>
              <span className="text-text-muted">Legacy Pin</span>
              <div className={`mt-0.5 ${latestCompatibility.pinnedToLegacy ? "text-warning" : "text-text-secondary"}`}>
                {latestCompatibility.pinnedToLegacy ? "Pinned for this run" : "Not pinned"}
              </div>
            </div>
            <div>
              <span className="text-text-muted">Legacy Rerun</span>
              <div className="font-mono mt-0.5 break-words">{latestCompatibility.legacy.rerunOrder.join(" -> ") || "none"}</div>
            </div>
            <div>
              <span className="text-text-muted">Repair Rerun</span>
              <div className="font-mono mt-0.5 break-words">{latestCompatibility.repair.rerunOrder.join(" -> ") || "none"}</div>
            </div>
          </div>
          {latestCompatibility.reasons.length > 0 && (
            <div className="mt-3 text-[13px] text-text-secondary space-y-1">
              {latestCompatibility.reasons.slice(0, 3).map((reason, index) => (
                <div key={index}>{reason}</div>
              ))}
              {latestCompatibility.reasons.length > 3 && (
                <div className="text-text-muted">+{latestCompatibility.reasons.length - 3} more divergence reasons</div>
              )}
            </div>
          )}
        </div>
      )}

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

      {/* Workspace diff approval */}
      <div className="bg-elevated border border-border rounded-lg p-3 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="text-sm font-semibold text-text">Workspace Changes</div>
          <div className="text-[12px] text-text-muted">
            {(workspaceDiff?.total ?? run.pendingWorkspaceChanges ?? 0) > 0
              ? `${workspaceDiff?.total ?? run.pendingWorkspaceChanges} pending`
              : "none"}
          </div>
        </div>

        {(workspaceDiff?.total ?? run.pendingWorkspaceChanges ?? 0) > 0 && (
          <div className="text-[12px] text-text-secondary">
            Codegen/file edits are isolated until you apply them.
          </div>
        )}

        {workspaceDiff && workspaceDiff.total > 0 && (
          <div className="space-y-1 text-[12px] font-mono text-text-secondary">
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
            className="px-3 py-1.5 text-[13px] text-accent bg-accent/10 hover:bg-accent/20 rounded-lg transition-colors"
            onClick={() => refreshWorkspaceDiff(run.id)}
            disabled={workspaceLoading || !run}
          >
            {workspaceLoading ? "Loading..." : "Refresh Diff"}
          </button>
          {(workspaceDiff?.total ?? run.pendingWorkspaceChanges ?? 0) > 0 && (
            <button
              className="px-3 py-1.5 text-[13px] text-success bg-success/10 hover:bg-success/20 rounded-lg transition-colors"
              onClick={handleApplyWorkspaceDiff}
              disabled={workspaceLoading}
            >
              Apply Changes
            </button>
          )}
        </div>

        {workspaceResult && (
          <div className="text-[12px] text-text-secondary">{workspaceResult}</div>
        )}
      </div>
    </div>
  )
}
