/**
 * Thread + run navigator — shared by the Threads widget and IOE runs sidebar.
 */

import { ChevronRight, Plus, Trash2 } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { api } from "../../api"
import { RunStatus } from "../../enums"
import { useStore } from "../../store"
import type { Run, Thread } from "../../types"
import { timeAgo } from "../../util"
import { C, statusDot } from "../../widgets/ioe/constants"
import { DeleteThreadModal } from "./DeleteThreadModal"
import { ThreadRowMenu } from "./ThreadRowMenu"

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

  if (variant === "widget") {
    return (
      <button
        type="button"
        className={`thread-nav-run ${active ? "thread-nav-run--active" : ""}`}
        onClick={onSelect}
      >
        <span
          className="thread-nav-run-dot"
          style={{ background: statusDot(run.status) }}
          aria-hidden
        />
        <span className="thread-nav-run-goal">{run.goal}</span>
        <span className="thread-nav-run-meta">
          {isLive ? "live" : timeAgo(run.createdAt)}
        </span>
      </button>
    )
  }

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

function WidgetThreadBlock({
  thread,
  active,
  expanded,
  runs,
  loading,
  activeRunId,
  onToggle,
  onSelectThread,
  onSelectRun,
  onDeleteThread,
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
  onDeleteThread: () => void
}) {
  const upsertThread = useStore((s) => s.upsertThread)
  const [editing, setEditing] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [draft, setDraft] = useState(thread.title || "New thread")
  const inputRef = useRef<HTMLInputElement>(null)
  const titleRef = useRef<HTMLSpanElement>(null)
  const rowRef = useRef<HTMLDivElement>(null)
  const [titleTooltipOpen, setTitleTooltipOpen] = useState(false)
  const [titleTooltipAnchor, setTitleTooltipAnchor] = useState<DOMRect | null>(null)
  const displayTitle = thread.title || "New thread"
  const runCount = thread.runCount ?? runs?.length ?? 0

  const closeTitleTooltip = () => {
    setTitleTooltipOpen(false)
    setTitleTooltipAnchor(null)
  }

  const openTitleTooltip = () => {
    if (menuOpen) return
    const el = titleRef.current
    if (!el || el.scrollWidth <= el.clientWidth + 1) return
    const rect = rowRef.current?.getBoundingClientRect()
    if (!rect) return
    setTitleTooltipAnchor(rect)
    setTitleTooltipOpen(true)
  }

  useEffect(() => {
    if (!editing) setDraft(displayTitle)
  }, [displayTitle, editing])

  useEffect(() => {
    if (editing) inputRef.current?.focus()
  }, [editing])

  const commitRename = async () => {
    const next = draft.trim() || "New thread"
    setEditing(false)
    if (next === displayTitle) return
    try {
      const updated = await api.updateThread(thread.id, { title: next })
      upsertThread(updated)
    } catch {
      setDraft(displayTitle)
    }
  }

  if (editing) {
    return (
      <div className="thread-nav-thread thread-nav-thread--editing">
        <input
          ref={inputRef}
          type="text"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => void commitRename()}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault()
              void commitRename()
            }
            if (event.key === "Escape") {
              setDraft(displayTitle)
              setEditing(false)
            }
          }}
          className="thread-rail-rename-input thread-nav-rename-input"
          aria-label="Rename thread"
        />
      </div>
    )
  }

  return (
    <div
      className={[
        "thread-nav-thread group",
        active ? "thread-nav-thread--active" : "",
        expanded ? "thread-nav-thread--expanded" : "",
        thread.pinned ? "thread-nav-thread--pinned" : "",
        menuOpen ? "thread-nav-thread--menu-open" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="thread-nav-thread-row">
        <button
          type="button"
          className="thread-nav-chevron"
          aria-label={expanded ? "Collapse runs" : "Expand runs"}
          aria-expanded={expanded}
          onClick={onToggle}
        >
          <ChevronRight size={13} strokeWidth={1.75} className="thread-nav-chevron-icon" data-expanded={expanded || undefined} />
        </button>
        <div
          ref={rowRef}
          className="thread-nav-thread-body"
          onMouseEnter={openTitleTooltip}
          onMouseLeave={closeTitleTooltip}
          onFocus={openTitleTooltip}
          onBlur={closeTitleTooltip}
        >
          <button type="button" className="thread-nav-thread-btn" onClick={onSelectThread}>
            <div className="thread-nav-thread-title-line min-w-0">
              <span ref={titleRef} className="thread-nav-thread-title block min-w-0 truncate">
                {displayTitle}
              </span>
            </div>
            <span className="thread-nav-thread-meta block min-w-0 truncate">
              {runCount} {runCount === 1 ? "run" : "runs"}
            </span>
          </button>
          <div className="thread-nav-thread-actions">
            <ThreadRowMenu
              thread={thread}
              onRequestDelete={onDeleteThread}
              onRenameStart={() => setEditing(true)}
              onMenuOpenChange={setMenuOpen}
            />
          </div>
          {titleTooltipOpen && titleTooltipAnchor && createPortal(
            <div
              className="thread-rail-title-tooltip"
              role="tooltip"
              style={{
                top: titleTooltipAnchor.top + titleTooltipAnchor.height / 2,
                left: titleTooltipAnchor.right + 10,
              }}
            >
              {displayTitle}
            </div>,
            document.body,
          )}
        </div>
      </div>

      <div className={`thread-nav-runs-wrap${expanded ? " thread-nav-runs-wrap--open" : ""}`}>
        <div className="thread-nav-runs-inner">
          <div className="thread-nav-runs">
            {loading && <div className="thread-nav-runs-status">Loading runs…</div>}
            {!loading && (runs?.length ?? 0) === 0 && (
              <div className="thread-nav-runs-status">No runs yet</div>
            )}
            {runs?.map((run) => (
              <RunRow
                key={run.id}
                run={run}
                active={run.id === activeRunId}
                variant="widget"
                onSelect={() => onSelectRun(run.id)}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
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
  onDeleteThread,
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
  onDeleteThread: () => void
  variant: Variant
}) {
  const title = thread.title || "New thread"
  const runCount = thread.runCount ?? runs?.length ?? 0

  if (variant === "widget") {
    return (
      <WidgetThreadBlock
        thread={thread}
        active={active}
        expanded={expanded}
        runs={runs}
        loading={loading}
        activeRunId={activeRunId}
        onToggle={onToggle}
        onSelectThread={onSelectThread}
        onSelectRun={onSelectRun}
        onDeleteThread={onDeleteThread}
      />
    )
  }

  return (
    <div className="group">
      <div className="flex items-stretch">
        <button
          type="button"
          aria-label={expanded ? "Collapse runs" : "Expand runs"}
          className="shrink-0 px-1 text-text-muted"
          onClick={onToggle}
        >
          <ChevronRight size={14} className={`transition-transform ${expanded ? "rotate-90" : ""}`} />
        </button>
        <button
          type="button"
          className="w-full flex items-center gap-1.5 px-3 py-1.5 text-left hover:bg-overlay-2 transition-colors flex-1 min-w-0"
          style={active ? { background: "rgba(123,111,199,0.08)" } : undefined}
          onClick={onSelectThread}
        >
          <span className="truncate flex-1 text-[13px]" style={{ color: C.text }}>{title}</span>
          <span className="shrink-0 text-xs tabular-nums" style={{ color: C.dim }}>{runCount}</span>
        </button>
        <button
          type="button"
          aria-label={`Delete ${title}`}
          className="shrink-0 px-2 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity hover:bg-overlay-2"
          style={{ color: C.dim }}
          onClick={(event) => {
            event.stopPropagation()
            onDeleteThread()
          }}
        >
          <Trash2 size={14} />
        </button>
      </div>
      {expanded && (
        <div>
          {loading && <div className="px-6 py-2 text-xs" style={{ color: C.dim }}>Loading…</div>}
          {!loading && (runs?.length ?? 0) === 0 && (
            <div className="px-6 py-2 text-xs" style={{ color: C.dim }}>No runs</div>
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
  const deleteThread = useStore((s) => s.deleteThread)
  const createNewThread = useStore((s) => s.createNewThread)

  const [expandedId, setExpandedId] = useState<string | null>(activeThreadId)
  const [runsByThread, setRunsByThread] = useState<Record<string, Run[]>>({})
  const [loadingId, setLoadingId] = useState<string | null>(null)
  const [deleteCandidate, setDeleteCandidate] = useState<Thread | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

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
  }

  const handleSelectRun = async (threadId: string, runId: string) => {
    await selectRun(runId, threadId)
  }

  const handleDeleteThread = (thread: Thread) => {
    setDeleteError(null)
    setDeleteCandidate(thread)
  }

  const confirmDeleteThread = async () => {
    if (!deleteCandidate) return
    const threadId = deleteCandidate.id
    setDeleting(true)
    setDeleteError(null)
    try {
      await deleteThread(threadId)
      setRunsByThread((prev) => {
        const next = { ...prev }
        delete next[threadId]
        return next
      })
      setDeleteCandidate(null)
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Failed to delete thread")
    } finally {
      setDeleting(false)
    }
  }

  const list = (
    <>
      {threads.length === 0 ? (
        <div className={variant === "widget" ? "thread-nav-empty" : "px-4 py-3 text-[13px]"} style={variant === "ioe" ? { color: C.dim } : undefined}>
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
            onDeleteThread={() => handleDeleteThread(thread)}
            variant={variant}
          />
        ))
      )}
    </>
  )

  const deleteModal = deleteCandidate ? (
    <DeleteThreadModal
      thread={deleteCandidate}
      busy={deleting}
      error={deleteError}
      onClose={() => {
        if (!deleting) {
          setDeleteCandidate(null)
          setDeleteError(null)
        }
      }}
      onConfirm={confirmDeleteThread}
    />
  ) : null

  if (variant === "widget") {
    return (
      <>
        <div className="thread-nav-panel">
          <div className="thread-nav-scroll">{list}</div>
          <button
            type="button"
            className="thread-nav-new"
            onClick={() => void createNewThread()}
          >
            <Plus size={14} strokeWidth={2} />
            <span>New thread</span>
          </button>
        </div>
        {deleteModal}
      </>
    )
  }

  return (
    <>
      <div className="text-[13px] min-h-0 overflow-y-auto">
        <div className="flex items-center justify-end gap-2 px-3 py-2 border-b border-border/40">
          <button
            type="button"
            onClick={() => void createNewThread()}
            className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded hover:bg-overlay-2"
            style={{ color: C.textSecondary }}
            title="New thread"
          >
            <Plus size={14} />
            <span>New</span>
          </button>
        </div>
        {list}
      </div>
      {deleteModal}
    </>
  )
}
