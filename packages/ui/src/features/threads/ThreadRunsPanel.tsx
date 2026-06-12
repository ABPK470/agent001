/**
 * Thread + run navigator — shared by the Threads widget and IOE runs sidebar.
 * Selecting a thread or run updates global activeThreadId / activeRunId.
 */

import { ChevronRight, Plus } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { api } from "../../api"
import { RunStatus } from "../../enums"
import { useStore } from "../../store"
import type { Run, Thread } from "../../types"
import { timeAgo } from "../../util"
import { C, statusDot } from "../../widgets/ioe/constants"

type Variant = "widget" | "ioe"

interface Props {
  variant?: Variant
}

function RunRow({
  run,
  active,
  onSelect,
  variant,
}: {
  run: Run
  active: boolean
  onSelect: () => void
  variant: Variant
}) {
  const isLive =
    run.status === RunStatus.Pending ||
    run.status === RunStatus.Running ||
    run.status === RunStatus.Planning

  if (variant === "ioe") {
    return (
      <button
        type="button"
        className="w-full text-left flex items-start gap-2 pl-6 pr-3 py-1.5 transition-colors hover:bg-overlay-2 cursor-pointer"
        style={{ background: active ? "rgba(123,111,199,0.08)" : "transparent" }}
        onClick={onSelect}
      >
        <span
          className="inline-block w-2 h-2 rounded-full mt-1 shrink-0"
          style={{ background: statusDot(run.status) }}
        />
        <div className="min-w-0 flex-1">
          <div className="truncate" style={{ color: C.text }}>{run.goal}</div>
          <div className="flex items-center gap-2 mt-0.5" style={{ color: C.dim }}>
            <span>{run.status}</span>
            <span>{timeAgo(run.createdAt)}</span>
            {isLive && <span style={{ color: C.warning }}>live</span>}
          </div>
        </div>
      </button>
    )
  }

  return (
    <button
      type="button"
      className={`w-full text-left rounded-lg px-3 py-2 text-sm transition-colors hover:bg-overlay-2 ${
        active ? "bg-accent/10 text-text" : "text-text-secondary"
      }`}
      onClick={onSelect}
    >
      <div className="truncate font-medium">{run.goal}</div>
      <div className="mt-0.5 flex items-center gap-2 text-xs text-text-muted">
        <span>{run.status}</span>
        <span>{timeAgo(run.createdAt)}</span>
      </div>
    </button>
  )
}

function ThreadBlock({
  thread,
  active,
  expanded,
  runs,
  loading,
  activeRunId,
  onToggle,
  onSelectThread,
  onSelectRun,
  variant,
}: {
  thread: Thread
  active: boolean
  expanded: boolean
  runs: Run[] | undefined
  loading: boolean
  activeRunId: string | null
  onToggle: () => void
  onSelectThread: () => void
  onSelectRun: (runId: string) => void
  variant: Variant
}) {
  const title = thread.title || "New thread"
  const runCount = thread.runCount ?? runs?.length ?? 0

  const headClass =
    variant === "ioe"
      ? "w-full flex items-center gap-1.5 px-3 py-1.5 text-left hover:bg-overlay-2 transition-colors"
      : "w-full flex items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-overlay-2 transition-colors"

  return (
    <div className={variant === "widget" ? "mb-1" : ""}>
      <div className="flex items-stretch">
        <button
          type="button"
          aria-label={expanded ? "Collapse runs" : "Expand runs"}
          className={`shrink-0 px-1 ${variant === "ioe" ? "text-text-muted" : "text-text-muted hover:text-text"}`}
          onClick={onToggle}
        >
          <ChevronRight
            size={14}
            className={`transition-transform ${expanded ? "rotate-90" : ""}`}
          />
        </button>
        <button
          type="button"
          className={`${headClass} flex-1 min-w-0 ${
            active ? (variant === "ioe" ? "" : "bg-accent/10") : ""
          }`}
          style={
            variant === "ioe" && active
              ? { background: "rgba(123,111,199,0.08)" }
              : undefined
          }
          onClick={onSelectThread}
        >
          <span
            className={`truncate flex-1 ${variant === "ioe" ? "text-[13px]" : "text-sm font-medium"}`}
            style={variant === "ioe" ? { color: C.text } : undefined}
          >
            {title}
          </span>
          <span
            className="shrink-0 text-xs tabular-nums"
            style={variant === "ioe" ? { color: C.dim } : undefined}
          >
            {runCount}
          </span>
        </button>
      </div>
      {expanded && (
        <div className={variant === "widget" ? "ml-4 mt-0.5 space-y-0.5" : ""}>
          {loading && (
            <div
              className="px-6 py-2 text-xs"
              style={variant === "ioe" ? { color: C.dim } : undefined}
            >
              Loading…
            </div>
          )}
          {!loading && (runs?.length ?? 0) === 0 && (
            <div
              className="px-6 py-2 text-xs text-text-muted"
              style={variant === "ioe" ? { color: C.dim } : undefined}
            >
              No runs
            </div>
          )}
          {runs?.map((run) => (
            <RunRow
              key={run.id}
              run={run}
              active={run.id === activeRunId}
              variant={variant}
              onSelect={() => onSelectRun(run.id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export function ThreadRunsPanel({ variant = "widget" }: Props): React.ReactElement {
  const threads = useStore((s) => s.threads)
  const activeThreadId = useStore((s) => s.activeThreadId)
  const activeThreadRuns = useStore((s) => s.runs)
  const activeRunId = useStore((s) => s.activeRunId)
  const selectThread = useStore((s) => s.selectThread)
  const selectRun = useStore((s) => s.selectRun)
  const createNewThread = useStore((s) => s.createNewThread)

  const [expandedId, setExpandedId] = useState<string | null>(activeThreadId)
  const [runsByThread, setRunsByThread] = useState<Record<string, Run[]>>({})
  const [loadingId, setLoadingId] = useState<string | null>(null)

  useEffect(() => {
    if (activeThreadId) setExpandedId(activeThreadId)
  }, [activeThreadId])

  const loadRuns = useCallback(async (threadId: string) => {
    let alreadyLoaded = false
    setRunsByThread((prev) => {
      alreadyLoaded = prev[threadId] !== undefined
      return prev
    })
    if (alreadyLoaded) return
    setLoadingId(threadId)
    try {
      const runs = await api.listThreadRuns(threadId)
      setRunsByThread((prev) => ({ ...prev, [threadId]: runs }))
    } catch {
      setRunsByThread((prev) => ({ ...prev, [threadId]: [] }))
    } finally {
      setLoadingId((id) => (id === threadId ? null : id))
    }
  }, [])

  useEffect(() => {
    if (expandedId) void loadRuns(expandedId)
  }, [expandedId, loadRuns])

  useEffect(() => {
    if (!activeThreadId) return
    setRunsByThread((prev) => ({ ...prev, [activeThreadId]: activeThreadRuns }))
  }, [activeThreadId, activeThreadRuns])

  const handleToggle = (threadId: string) => {
    setExpandedId((prev) => (prev === threadId ? null : threadId))
  }

  const handleSelectThread = async (threadId: string) => {
    setExpandedId(threadId)
    await selectThread(threadId)
    const cached = runsByThread[threadId]
    if (cached) {
      setRunsByThread((prev) => ({ ...prev, [threadId]: cached }))
    }
  }

  const handleSelectRun = async (threadId: string, runId: string) => {
    await selectRun(runId, threadId)
    setRunsByThread((prev) => {
      const list = prev[threadId]
      if (!list?.some((r) => r.id === runId)) return prev
      return prev
    })
  }

  const shellClass =
    variant === "ioe"
      ? "text-[13px] min-h-0 overflow-y-auto"
      : "flex h-full min-h-0 flex-col text-text"

  return (
    <div className={shellClass}>
      <div
        className={
          variant === "widget"
            ? "flex items-center justify-between gap-2 border-b border-border px-3 py-2 shrink-0"
            : "flex items-center justify-end gap-2 px-3 py-2 border-b border-border/40"
        }
      >
        {variant === "widget" && (
          <span className="text-xs font-semibold uppercase tracking-wider text-text-muted">
            Threads
          </span>
        )}
        <button
          type="button"
          onClick={() => void createNewThread()}
          className={
            variant === "ioe"
              ? "inline-flex items-center gap-1 text-xs px-2 py-1 rounded hover:bg-overlay-2"
              : "inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-accent hover:bg-accent/10"
          }
          style={variant === "ioe" ? { color: C.textSecondary } : undefined}
          title="New thread"
        >
          <Plus size={14} />
          <span>New</span>
        </button>
      </div>

      <div className={variant === "widget" ? "flex-1 min-h-0 overflow-y-auto p-2" : ""}>
        {threads.length === 0 ? (
          <div
            className="px-4 py-3 text-sm text-text-muted"
            style={variant === "ioe" ? { color: C.dim } : undefined}
          >
            No threads yet
          </div>
        ) : (
          threads.map((thread) => (
            <ThreadBlock
              key={thread.id}
              thread={thread}
              active={thread.id === activeThreadId}
              expanded={expandedId === thread.id}
              runs={
                thread.id === activeThreadId
                  ? activeThreadRuns
                  : runsByThread[thread.id]
              }
              loading={loadingId === thread.id}
              activeRunId={activeRunId}
              onToggle={() => handleToggle(thread.id)}
              onSelectThread={() => void handleSelectThread(thread.id)}
              onSelectRun={(runId) => void handleSelectRun(thread.id, runId)}
              variant={variant}
            />
          ))
        )}
      </div>
    </div>
  )
}
