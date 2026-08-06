/**
 * Trace scope drawer — pick-only Thread/Run tree. Same store path as breadcrumbs.
 * Not a second Threads widget (no pin/delete/rename/new).
 */

import { useMemo } from "react"
import { useStore } from "../../state/store"
import {
  runLabel,
  runsForActiveThread,
  threadLabel,
} from "./trace-run-context"
import { sortThreadsByPinThenUpdatedAt } from "../../lib/thread-order"

export function TraceScopeDrawer({
  onPicked,
}: {
  /** Collapse after a successful selection. */
  onPicked: () => void
}) {
  const threads = useStore((s) => s.threads)
  const runs = useStore((s) => s.runs)
  const activeThreadId = useStore((s) => s.activeThreadId)
  const activeRunId = useStore((s) => s.activeRunId)
  const selectThread = useStore((s) => s.selectThread)
  const selectRun = useStore((s) => s.selectRun)

  const ordered = useMemo(() => sortThreadsByPinThenUpdatedAt(threads), [threads])

  function onPickThread(threadId: string) {
    // Keep drawer open so the operator can pick a specific run next.
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

  return (
    <nav className="trace-scope-drawer" aria-label="Threads and runs">
      <div className="trace-scope-drawer__head">Threads</div>
      <ul className="trace-scope-drawer__list">
        {ordered.length === 0 ? (
          <li className="trace-scope-drawer__empty">No threads yet</li>
        ) : (
          ordered.map((thread) => {
            const threadRuns = runsForActiveThread(runs, thread.id)
            const threadActive = thread.id === activeThreadId
            return (
              <li key={thread.id} className="trace-scope-drawer__thread">
                <button
                  type="button"
                  className={`trace-scope-drawer__thread-btn${threadActive ? " is-active" : ""}`}
                  onClick={() => onPickThread(thread.id)}
                >
                  <span className="trace-scope-drawer__thread-label">{threadLabel(thread)}</span>
                  <span className="trace-scope-drawer__count tabular-nums">
                    {threadRuns.length}
                  </span>
                </button>
                {threadRuns.length > 0 ? (
                  <ul className="trace-scope-drawer__runs">
                    {threadRuns.map((run) => {
                      const runActive = run.id === activeRunId
                      return (
                        <li key={run.id}>
                          <button
                            type="button"
                            className={`trace-scope-drawer__run-btn${runActive ? " is-active" : ""}`}
                            onClick={() => onPickRun(run.id, thread.id)}
                            title={runLabel(run)}
                          >
                            <span className="trace-scope-drawer__run-label">{runLabel(run)}</span>
                            <span className="trace-scope-drawer__run-status">{run.status}</span>
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                ) : (
                  <p className="trace-scope-drawer__empty-runs">No runs</p>
                )}
              </li>
            )
          })
        )}
      </ul>
    </nav>
  )
}
