import { useCallback, useEffect, useState } from "react"
import { api } from "../api"

const POLL_MS = 15000

/** Polls /api/health — true when the server process is up (independent of SSE/auth). */
export function useServerReachable(enabled = true): { reachable: boolean } {
  const [reachable, setReachable] = useState(false)

  const probe = useCallback(async () => {
    if (!enabled) {
      setReachable(false)
      return
    }
    try {
      await api.health()
      setReachable(true)
    } catch {
      setReachable(false)
    }
  }, [enabled])

  useEffect(() => {
    void probe()
    if (!enabled) return
    const id = window.setInterval(() => void probe(), POLL_MS)
    return () => window.clearInterval(id)
  }, [enabled, probe])

  return { reachable }
}
