import { useEffect } from "react"
import { api, createWs } from "./api"
import { Canvas } from "./components/Canvas"
import { Toolbar } from "./components/Toolbar"
import { ViewTabs } from "./components/ViewTabs"
import { useStore } from "./store"

export function App() {
  const setConnected = useStore((s) => s.setConnected)
  const handleWsEvent = useStore((s) => s.handleWsEvent)
  const setRuns = useStore((s) => s.setRuns)

  // Connect WebSocket
  useEffect(() => {
    const ws = createWs(handleWsEvent, setConnected)
    return () => ws.close()
  }, [handleWsEvent, setConnected])

  // Load initial runs
  useEffect(() => {
    api.listRuns().then(setRuns).catch(() => {})
  }, [setRuns])

  return (
    <div className="flex flex-col h-screen bg-base">
      <Toolbar />
      <ViewTabs />
      <Canvas />
    </div>
  )
}
