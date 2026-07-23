/**
 * Trace widget shell — store → hybrid DAG view.
 */

import { useMemo } from "react"
import { EmptyState } from "../components/EmptyState"
import { ToastStack, useWidgetToasts } from "../components/useWidgetToasts"
import { useStore } from "../state/store"
import { WIDGET_ICONS } from "./widget-icons"
import { buildTraceDag } from "./trace/build-trace-dag"
import { TraceDag } from "./trace/TraceDag"

export function DebugInspector() {
  const trace = useStore((s) => s.trace)
  const activeRunId = useStore((s) => s.activeRunId)
  const activeThreadId = useStore((s) => {
    if (!s.activeRunId) return null
    return s.runs.find((r) => r.id === s.activeRunId)?.threadId ?? null
  })
  const { toasts, dismissToast, notify, notifyError } = useWidgetToasts()

  const dag = useMemo(() => buildTraceDag(trace), [trace])

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
        emptySlot={emptySlot}
        onExportMessage={notify}
        onExportError={notifyError}
      />
    </>
  )
}
