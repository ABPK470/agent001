import { useCallback, useEffect, useState } from "react"
import { api, type PlatformHealth } from "../client/index"

export function usePlatformHealth(enabled: boolean): {
  health: PlatformHealth | null
  loading: boolean
  refresh: () => Promise<PlatformHealth | null>
} {
  const [health, setHealth] = useState<PlatformHealth | null>(null)
  const [loading, setLoading] = useState(enabled)

  const refresh = useCallback(async () => {
    if (!enabled) {
      setHealth(null)
      setLoading(false)
      return null
    }
    setLoading(true)
    try {
      const next = await api.getPlatformHealth()
      setHealth(next)
      return next
    } catch {
      setHealth(null)
      return null
    } finally {
      setLoading(false)
    }
  }, [enabled])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return { health, loading, refresh }
}
