/**
 * Trace widget shell — store → hybrid DAG view.
 */

import { useMemo, useRef } from "react"
import { useTilePaint } from "../app/workspace/tile-paint"
import { EmptyState } from "../components/EmptyState"
import { ToastStack, useWidgetToasts } from "../components/useWidgetToasts"
import { useStore } from "../state/store"
import { WIDGET_ICONS } from "./widget-icons"
import { buildTraceDag, type TraceDag as TraceDagModel } from "./trace/build-trace-dag"
import { TraceDag } from "./trace/TraceDag"

export function DebugInspector() {
  const { soloHidden } = useTilePaint()
  const trace = useStore((s) => s.trace)
  const traceCreatedAtMs = useStore((s) => s.traceCreatedAtMs)
  const activeRunId = useStore((s) => s.activeRunId)
  const runs = useStore((s) => s.runs)
  const activeThreadId = useStore((s) => {
    if (!s.activeRunId) return null
    return s.runs.find((r) => r.id === s.activeRunId)?.threadId ?? null
  })
  const { toasts, dismissToast, notify, notifyError } = useWidgetToasts()

  // Solo-hidden: keep last DAG — do not rebuild while covered by maximize.
  const frozenDagRef = useRef<TraceDagModel | null>(null)
  const dag = useMemo(() => {
    if (soloHidden && frozenDagRef.current) return frozenDagRef.current
    const next = buildTraceDag(trace, { createdAtMs: traceCreatedAtMs })
    frozenDagRef.current = next
    return next
  }, [trace, traceCreatedAtMs, soloHidden])

  let emptySlot = null
  if (!activeRunId) {
    emptySlot = (
      <EmptyState
        icon={WIDGET_ICONS["debug-inspector"]}
        message="Select a run to inspect"
      />
    )
  } else if (!dag.hasData) {
    emptySlot = (
      <EmptyState
        icon={WIDGET_ICONS["debug-inspector"]}
        message={
          trace.length === 0
            ? "No trace data yet — start an agent run"
            : "No debug entries found — run may predate debug instrumentation"
        }
      />
    )
  }

  return (
    <>
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
      <TraceDag
        dag={dag}
        runId={activeRunId}
        threadId={activeThreadId}
        runs={runs}
        emptySlot={emptySlot}
        onExportMessage={notify}
        onExportError={notifyError}
      />
    </>
  )
}
