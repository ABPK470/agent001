/**
 * Trace scope drawer — floating Thread/Run overlay over the trace split.
 * Same store path as breadcrumbs; keyboard: j/k · Enter · Esc.
 * Row chrome matches Trace left DAG tree (depth pad + left rail).
 */

import { ChevronRight } from "lucide-react"
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react"
import { RunStatus } from "../../enums"
import { useStore } from "../../state/store"
import { operationStatusPill, statusAbbrevMeta } from "../../lib/status-callout"
import { timeAgo } from "../../lib/util"
import { sortThreadsByPinThenUpdatedAt } from "../../lib/thread-order"
import {
  runLabel,
  runsForActiveThread,
  threadLabel,
} from "./trace-run-context"
import {
  buildScopeDrawerItems,
  initialScopeDrawerIndex,
  moveScopeDrawerIndex,
  type ScopeDrawerItem,
} from "./trace-scope-drawer-nav"
import { scrollScopeDrawerRowIntoList } from "./trace-scope-drawer-scroll"
import { traceTreeNodeCellStyle } from "./trace-tree-guides"

function scopeRowClass(...parts: Array<string | false | undefined>): string {
  return parts.filter(Boolean).join(" ")
}

export function TraceScopeDrawer({
  onDismiss,
  motionReady = true,
}: {
  /** Esc / scrim dismiss — close without changing selection. */
  onDismiss: () => void
  /** False while the open transition runs — blocks focus/scroll jank. */
  motionReady?: boolean
}) {
  const threads = useStore((s) => s.threads)
  const runs = useStore((s) => s.runs)
  const activeThreadId = useStore((s) => s.activeThreadId)
  const activeRunId = useStore((s) => s.activeRunId)
  const selectRun = useStore((s) => s.selectRun)

  const rootRef = useRef<HTMLElement>(null)
  const ordered = useMemo(() => sortThreadsByPinThenUpdatedAt(threads), [threads])

  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => {
    const next = new Set<string>()
    if (activeThreadId) next.add(activeThreadId)
    return next
  })
  const [focusIndex, setFocusIndex] = useState(-1)

  const runsByThread = useMemo(() => {
    const map = new Map<string, ReturnType<typeof runsForActiveThread>>()
    for (const thread of ordered) {
      map.set(thread.id, runsForActiveThread(runs, thread.id))
    }
    return map
  }, [ordered, runs])

  const items = useMemo(
    () => buildScopeDrawerItems(ordered, runsByThread, expandedIds),
    [ordered, runsByThread, expandedIds],
  )

  const seededFocusRef = useRef(false)

  useEffect(() => {
    if (seededFocusRef.current) return
    if (items.length === 0) return
    seededFocusRef.current = true
    setFocusIndex(initialScopeDrawerIndex(items, activeRunId, activeThreadId))
  }, [items, activeRunId, activeThreadId])

  useEffect(() => {
    if (!motionReady) return
    rootRef.current?.focus({ preventScroll: true })
  }, [motionReady])

  useEffect(() => {
    if (focusIndex >= items.length) {
      setFocusIndex(items.length > 0 ? items.length - 1 : -1)
      return
    }
    if (!motionReady || focusIndex < 0) return
    const root = rootRef.current
    if (!root) return
    const list = root.querySelector<HTMLElement>(".trace-scope-drawer__list")
    const row = root.querySelector<HTMLElement>(`[data-scope-idx="${focusIndex}"]`)
    if (!list || !row) return
    scrollScopeDrawerRowIntoList(list, row)
  }, [focusIndex, items, motionReady])

  function toggleExpand(threadId: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(threadId)) next.delete(threadId)
      else next.add(threadId)
      return next
    })
  }

  function onPickRun(runId: string, threadId: string) {
    void selectRun(runId, threadId).catch((err: unknown) => {
      console.error("[mia] TraceScopeDrawer selectRun", err)
    })
  }

  function activateItem(item: ScopeDrawerItem) {
    if (item.kind === "thread") {
      toggleExpand(item.threadId)
      return
    }
    onPickRun(item.runId, item.threadId)
  }

  function onDrawerKeyDown(event: ReactKeyboardEvent) {
    if (items.length === 0) {
      if (event.key === "Escape") {
        event.preventDefault()
        event.stopPropagation()
        onDismiss()
      }
      return
    }

    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      onDismiss()
      return
    }

    if (event.key === "ArrowDown" || event.key === "j") {
      event.preventDefault()
      event.stopPropagation()
      setFocusIndex((i) => moveScopeDrawerIndex(items.length, i, 1))
      return
    }
    if (event.key === "ArrowUp" || event.key === "k") {
      event.preventDefault()
      event.stopPropagation()
      setFocusIndex((i) => moveScopeDrawerIndex(items.length, i, -1))
      return
    }

    const item = focusIndex >= 0 ? items[focusIndex] : null
    if (!item) return

    if (event.key === "ArrowRight" && item.kind === "thread" && !item.expanded) {
      event.preventDefault()
      event.stopPropagation()
      toggleExpand(item.threadId)
      return
    }
    if (event.key === "ArrowLeft" && item.kind === "thread" && item.expanded) {
      event.preventDefault()
      event.stopPropagation()
      toggleExpand(item.threadId)
      return
    }
    if (event.key === "Enter") {
      event.preventDefault()
      event.stopPropagation()
      activateItem(item)
    }
  }

  let rowIndex = -1

  return (
    <nav
      ref={rootRef}
      className="trace-scope-drawer"
      aria-label="Threads and runs"
      tabIndex={0}
      onKeyDown={onDrawerKeyDown}
    >
      <div className="trace-scope-drawer__head">
        <span className="trace-scope-drawer__title">Threads &amp; runs</span>
        <span className="trace-scope-drawer__esc" aria-hidden>
          <kbd className="composer-kbd">Esc</kbd>
        </span>
      </div>
      <ul className="trace-scope-drawer__list" role="listbox">
        {ordered.length === 0 ? (
          <li className="trace-scope-drawer__empty">No threads yet</li>
        ) : (
          ordered.map((thread) => {
            const threadRuns = runsByThread.get(thread.id) ?? []
            const expanded = expandedIds.has(thread.id)
            rowIndex += 1
            const threadIdx = rowIndex
            return (
              <li key={thread.id} className="trace-scope-drawer__thread">
                <div
                  className={scopeRowClass(
                    "trace-tree-row",
                    "is-branch",
                    "is-root",
                    "has-subtitle",
                    focusIndex === threadIdx && "is-selected",
                  )}
                >
                  <button
                    type="button"
                    data-scope-idx={threadIdx}
                    role="option"
                    tabIndex={-1}
                    aria-selected={focusIndex === threadIdx}
                    className="trace-tree-row__btn"
                    onClick={() => {
                      setFocusIndex(threadIdx)
                      toggleExpand(thread.id)
                    }}
                  >
                    <span
                      className="trace-tree-row__node-cell"
                      style={traceTreeNodeCellStyle(0)}
                    >
                      <span
                        className="trace-tree-row__chev"
                        role="presentation"
                        aria-label={expanded ? "Collapse runs" : "Expand runs"}
                        aria-expanded={expanded}
                        onClick={(event) => {
                          event.stopPropagation()
                          setFocusIndex(threadIdx)
                          toggleExpand(thread.id)
                        }}
                      >
                        <ChevronRight
                          size={13}
                          className={`trace-tree-row__chev-icon${expanded ? " is-open" : ""}`}
                        />
                      </span>
                      <span className="trace-tree-row__text-block">
                        <span className="trace-tree-row__name" title={threadLabel(thread)}>
                          {threadLabel(thread)}
                        </span>
                        <span className="trace-tree-row__subtitle tabular-nums">
                          {threadRuns.length} {threadRuns.length === 1 ? "run" : "runs"}
                        </span>
                      </span>
                    </span>
                  </button>
                </div>
                {expanded
                  ? threadRuns.map((run) => {
                      rowIndex += 1
                      const runIdx = rowIndex
                      const isLive =
                        run.status === RunStatus.Pending ||
                        run.status === RunStatus.Running ||
                        run.status === RunStatus.Planning
                      const statusMeta = statusAbbrevMeta(run.status)
                      return (
                        <div
                          key={run.id}
                          className={scopeRowClass(
                            "trace-tree-row",
                            "is-leaf",
                            "is-child",
                            focusIndex === runIdx && "is-selected",
                          )}
                        >
                          <button
                            type="button"
                            data-scope-idx={runIdx}
                            role="option"
                            tabIndex={-1}
                            aria-selected={focusIndex === runIdx}
                            className="trace-tree-row__btn"
                            onClick={() => {
                              setFocusIndex(runIdx)
                              onPickRun(run.id, thread.id)
                            }}
                          >
                            <span
                              className="trace-tree-row__node-cell"
                              style={traceTreeNodeCellStyle(1)}
                            >
                              <span className="trace-tree-row__chev" aria-hidden>
                                <span className="trace-tree-row__chev-spacer" />
                              </span>
                              <span className="trace-tree-row__text-block">
                                <span className="trace-tree-row__name" title={runLabel(run)}>
                                  {runLabel(run)}
                                </span>
                              </span>
                              <span className="trace-scope-drawer__run-trailing">
                                <span className="trace-scope-drawer__run-meta tabular-nums">
                                  {isLive ? "live" : timeAgo(run.createdAt)}
                                </span>
                                <span
                                  className={`trace-scope-drawer__run-status ${operationStatusPill(run.status)}`}
                                  title={statusMeta.title}
                                >
                                  {statusMeta.label}
                                </span>
                              </span>
                            </span>
                          </button>
                        </div>
                      )
                    })
                  : null}
                {expanded && threadRuns.length === 0 ? (
                  <p className="trace-scope-drawer__empty-runs">No runs</p>
                ) : null}
              </li>
            )
          })
        )}
      </ul>
    </nav>
  )
}
