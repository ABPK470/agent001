import { useEffect, useRef } from "react"
import { api, createWs } from "./api"
import { Canvas, type CanvasHandle } from "./components/Canvas"
import { Toolbar } from "./components/Toolbar"
import { ViewTabs } from "./components/ViewTabs"
import { useStore } from "./store"
import type { WidgetType } from "./types"
import { widgetRegistry } from "./widgets"

/** Detect ?widget= param for pop-out mode */
function getPopOutWidget(): { type: WidgetType; runId: string | null } | null {
  const params = new URLSearchParams(window.location.search)
  const type = params.get("widget") as WidgetType | null
  if (!type || !(type in widgetRegistry)) return null
  return { type, runId: params.get("runId") }
}

export function App() {
  const setConnected = useStore((s) => s.setConnected)
  const handleWsEvent = useStore((s) => s.handleWsEvent)
  const setRuns = useStore((s) => s.setRuns)
  const setActiveRun = useStore((s) => s.setActiveRun)
  const setSteps = useStore((s) => s.setSteps)
  const setLogs = useStore((s) => s.setLogs)
  const setAudit = useStore((s) => s.setAudit)
  const canvasRef = useRef<CanvasHandle>(null)

  const popOut = getPopOutWidget()

  // Connect WebSocket
  useEffect(() => {
    const ws = createWs(handleWsEvent, setConnected)
    return () => ws.close()
  }, [handleWsEvent, setConnected])

  // Load initial runs
  useEffect(() => {
    api.listRuns().then(setRuns).catch(() => {})
  }, [setRuns])

  // Pop-out: load run detail so the widget has full state
  useEffect(() => {
    if (!popOut?.runId) return
    setActiveRun(popOut.runId)
    api.getRun(popOut.runId).then((detail) => {
      const steps = (detail.data?.steps ?? []).map((s, i) => ({
        id: s.id ?? `step-${i}`,
        name: s.name ?? "Step",
        action: s.action ?? "",
        status: s.status ?? "completed",
        order: s.order ?? i,
        input: s.input ?? {},
        output: s.output ?? {},
        error: s.error ?? null,
        startedAt: s.startedAt as string | null ?? null,
        completedAt: s.completedAt as string | null ?? null,
      }))
      setSteps(steps)
      setLogs(detail.logs ?? [])
      setAudit(detail.audit ?? [])
    }).catch(() => {})
  }, [popOut?.runId, setActiveRun, setSteps, setLogs, setAudit])

  // Pop-out mode: render only the requested widget
  if (popOut) {
    const Widget = widgetRegistry[popOut.type]
    return (
      <div className="flex flex-col h-screen bg-surface p-4">
        <Widget />
      </div>
    )
  }

  return (
    <div className="flex flex-col h-screen bg-base">
      <Toolbar />
      <ViewTabs onAddWidget={() => canvasRef.current?.openCatalog()} />
      <Canvas ref={canvasRef} />
    </div>
  )
}
