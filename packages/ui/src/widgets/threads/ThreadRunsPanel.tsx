/**
 * Thread + run navigator — shared by the Threads widget.
 */

import { ChevronRight, Plus } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { api } from "../../client/index"
import { EmptyState } from "../../components/EmptyState"
import { RunStatus } from "../../enums"
import { useStore } from "../../state/store"
import type { Run, Thread } from "../../types"
import { timeAgo } from "../../lib/util"
import { statusDot } from "../../theme/tokens"
import { WIDGET_ICONS } from "../../widgets/widget-icons"
import { DeleteThreadModal } from "./DeleteThreadModal"
import { ThreadRowMenu } from "./ThreadRowMenu"

function RunRow({
  run,
  active,
  onSelect,
}: {
  run: Run
  active: boolean
  onSelect: () => void
}) {
  const isLive =
    run.status === RunStatus.Pending ||
    run.status === RunStatus.Running ||
    run.status === RunStatus.Planning

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
  const emptyRuns = expanded && !loading && (runs?.length ?? 0) === 0

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
        emptyRuns ? "thread-nav-thread--empty" : "",
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
              <EmptyState
                icon={WIDGET_ICONS["thread-nav"]}
                message="No runs yet"
              />
            )}
            {runs?.map((run) => (
              <RunRow
                key={run.id}
                run={run}
                active={run.id === activeRunId}
                onSelect={() => onSelectRun(run.id)}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

export function ThreadRunsPanel(): React.ReactElement {
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
        <EmptyState icon={WIDGET_ICONS["thread-nav"]} message="No threads yet" />
      ) : (
        threads.map((thread) => (
          <WidgetThreadBlock
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
