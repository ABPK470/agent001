/**
 * Trace scope bar — Thread ▾ / Run ▾. Store selectThread / selectRun only.
 * Scope precedes content (toolbar + meta); never buried in telemetry.
 */

import { useEffect, useMemo, useRef, useState } from "react"
import { Listbox } from "../../components/Listbox"
import { useStore } from "../../state/store"
import {
  TRACE_RUN_CONTEXT_COMBINED_MAX_PX,
  combinedRunOptions,
  decodeCombinedValue,
  resolveCombinedListboxValue,
  resolveRunListboxValue,
  runOptionsForThread,
  runsForActiveThread,
  threadOptions,
} from "./trace-run-context"

export function TraceRunContext({
  className = "",
  /** Zen HUD fixed row — one combined pill when space is tight. */
  compact = false,
}: {
  className?: string
  compact?: boolean
}) {
  const threads = useStore((s) => s.threads)
  const runs = useStore((s) => s.runs)
  const activeThreadId = useStore((s) => s.activeThreadId)
  const activeRunId = useStore((s) => s.activeRunId)
  const selectThread = useStore((s) => s.selectThread)
  const selectRun = useStore((s) => s.selectRun)

  const rootRef = useRef<HTMLDivElement>(null)
  const [narrow, setNarrow] = useState(false)

  useEffect(() => {
    if (compact) return
    const el = rootRef.current
    if (!el || typeof ResizeObserver === "undefined") return
    const host =
      el.closest(".widget-review-controls") ??
      el.closest(".trace-zen-hud") ??
      el.parentElement
    if (!host) return
    const ro = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? host.clientWidth
      setNarrow(width < TRACE_RUN_CONTEXT_COMBINED_MAX_PX)
    })
    ro.observe(host)
    setNarrow(host.clientWidth < TRACE_RUN_CONTEXT_COMBINED_MAX_PX)
    return () => ro.disconnect()
  }, [compact])

  const combined = compact || narrow

  const threadOpts = useMemo(() => threadOptions(threads), [threads])
  const runsForThread = useMemo(
    () => runsForActiveThread(runs, activeThreadId),
    [runs, activeThreadId],
  )
  const runOpts = useMemo(
    () => runOptionsForThread(runs, activeThreadId),
    [runs, activeThreadId],
  )
  const runValue = resolveRunListboxValue(runsForThread, activeRunId)
  const noRuns = Boolean(activeThreadId) && runsForThread.length === 0

  const combinedOpts = useMemo(
    () => combinedRunOptions(threads, runs),
    [threads, runs],
  )
  const combinedValue = resolveCombinedListboxValue(
    threads,
    runs,
    activeThreadId,
    activeRunId,
  )

  const threadTitle =
    threadOpts.find((o) => o.value === activeThreadId)?.label ?? "Select thread"
  const runTitle = noRuns
    ? "No runs in thread"
    : (runOpts.find((o) => o.value === runValue)?.label ?? "Select run")
  const combinedTitle =
    combinedOpts.find((o) => o.value === combinedValue)?.label ??
    "Select thread › run"

  function onThreadChange(threadId: string) {
    if (!threadId) return
    void selectThread(threadId).catch((err: unknown) => {
      console.error("[mia] TraceRunContext selectThread", err)
    })
  }

  function onRunChange(runId: string) {
    if (!runId || !activeThreadId) return
    if (!runsForThread.some((run) => run.id === runId)) return
    void selectRun(runId, activeThreadId).catch((err: unknown) => {
      console.error("[mia] TraceRunContext selectRun", err)
    })
  }

  function onCombinedChange(value: string) {
    const decoded = decodeCombinedValue(value)
    if (!decoded) return
    if (!decoded.runId) {
      void selectThread(decoded.threadId).catch((err: unknown) => {
        console.error("[mia] TraceRunContext selectThread", err)
      })
      return
    }
    void selectRun(decoded.runId, decoded.threadId).catch((err: unknown) => {
      console.error("[mia] TraceRunContext selectRun", err)
    })
  }

  return (
    <div
      ref={rootRef}
      className={`trace-scope${combined ? " trace-scope--combined" : ""}${
        compact ? " trace-scope--compact" : ""
      }${className ? ` ${className}` : ""}`}
      role="navigation"
      aria-label="Trace scope"
    >
      {combined ? (
        <Listbox
          size="sm"
          variant="ghost"
          className="trace-scope__pill trace-scope__pill--combined"
          ariaLabel="Thread and run"
          title={combinedTitle}
          placeholder="Select thread › run"
          blankIsPlaceholder
          searchable={combinedOpts.length > 6}
          value={combinedValue}
          options={combinedOpts}
          onChange={onCombinedChange}
          disabled={combinedOpts.length === 0}
        />
      ) : (
        <>
          <Listbox
            size="sm"
            variant="ghost"
            className="trace-scope__pill trace-scope__pill--thread"
            ariaLabel="Thread"
            title={threadTitle}
            placeholder="Select thread"
            blankIsPlaceholder
            searchable={threadOpts.length > 6}
            value={activeThreadId ?? ""}
            options={threadOpts}
            onChange={onThreadChange}
            disabled={threadOpts.length === 0}
          />
          <span className="trace-scope__sep" aria-hidden>
            /
          </span>
          <Listbox
            size="sm"
            variant="ghost"
            className="trace-scope__pill trace-scope__pill--run"
            ariaLabel="Run"
            title={runTitle}
            placeholder={noRuns ? "No runs in thread" : "Select run"}
            blankIsPlaceholder
            searchable={runOpts.length > 6}
            value={noRuns ? "" : runValue}
            options={runOpts}
            onChange={onRunChange}
            disabled={!activeThreadId || noRuns}
          />
        </>
      )}
    </div>
  )
}
