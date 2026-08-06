/**
 * Trace scope drawer — floating pick-only Thread/Run overlay.
 * Same store path as breadcrumbs; keyboard: j/k · Enter · Esc.
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react"
import { useStore } from "../../state/store"
import { operationStatusPill } from "../../lib/status-callout"
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

export function TraceScopeDrawer({
  onPicked,
  onDismiss,
}: {
  /** After selecting a run — close + return focus to DAG. */
  onPicked: () => void
  /** Esc / header dismiss — close without selection change. */
  onDismiss: () => void
}) {
  const threads = useStore((s) => s.threads)
  const runs = useStore((s) => s.runs)
  const activeThreadId = useStore((s) => s.activeThreadId)
  const activeRunId = useStore((s) => s.activeRunId)
  const selectThread = useStore((s) => s.selectThread)
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
    if (focusIndex >= items.length) {
      setFocusIndex(items.length > 0 ? items.length - 1 : -1)
      return
    }
    if (focusIndex < 0) return
    const el = rootRef.current?.querySelector<HTMLElement>(
      `[data-scope-idx="${focusIndex}"]`,
    )
    el?.focus({ preventScroll: true })
    el?.scrollIntoView({ block: "nearest" })
  }, [focusIndex, items])

  function toggleExpand(threadId: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(threadId)) next.delete(threadId)
      else next.add(threadId)
      return next
    })
  }

  function onPickThread(threadId: string) {
    void selectThread(threadId).catch((err: unknown) => {
      console.error("[mia] TraceScopeDrawer selectThread", err)
    })
  }

  function onPickRun(runId: string, threadId: string) {
    void selectRun(runId, threadId)
      .then(() => onPicked())
      .catch((err: unknown) => {
        console.error("[mia] TraceScopeDrawer selectRun", err)
      })
  }

  function activateItem(item: ScopeDrawerItem) {
    if (item.kind === "thread") {
      toggleExpand(item.threadId)
      void selectThread(item.threadId).catch((err: unknown) => {
        console.error("[mia] TraceScopeDrawer selectThread", err)
      })
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
            const threadActive = thread.id === activeThreadId
            rowIndex += 1
            const threadIdx = rowIndex
            return (
              <li key={thread.id} className="trace-scope-drawer__thread">
                <button
                  type="button"
                  data-scope-idx={threadIdx}
                  role="option"
                  aria-selected={focusIndex === threadIdx}
                  aria-expanded={expanded}
                  className={`trace-scope-drawer__thread-btn${threadActive ? " is-active" : ""}${
                    focusIndex === threadIdx ? " is-focused" : ""
                  }`}
                  onClick={() => {
                    setFocusIndex(threadIdx)
                    onPickThread(thread.id)
                    toggleExpand(thread.id)
                  }}
                >
                  <span className="trace-scope-drawer__chev" aria-hidden>
                    {expanded ? "▾" : "▸"}
                  </span>
                  <span className="trace-scope-drawer__thread-label">{threadLabel(thread)}</span>
                  <span className="trace-scope-drawer__count tabular-nums">
                    {threadRuns.length}
                  </span>
                </button>
                {expanded && threadRuns.length > 0 ? (
                  <ul className="trace-scope-drawer__runs">
                    {threadRuns.map((run) => {
                      rowIndex += 1
                      const runIdx = rowIndex
                      const runActive = run.id === activeRunId
                      return (
                        <li key={run.id}>
                          <button
                            type="button"
                            data-scope-idx={runIdx}
                            role="option"
                            aria-selected={focusIndex === runIdx}
                            className={`trace-scope-drawer__run-btn${runActive ? " is-active" : ""}${
                              focusIndex === runIdx ? " is-focused" : ""
                            }`}
                            onClick={() => {
                              setFocusIndex(runIdx)
                              onPickRun(run.id, thread.id)
                            }}
                            title={runLabel(run)}
                          >
                            <span className="trace-scope-drawer__run-label">{runLabel(run)}</span>
                            <span
                              className={`trace-scope-drawer__run-status ${operationStatusPill(run.status)}`}
                              title={run.status}
                            >
                              {run.status}
                            </span>
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                ) : null}
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
