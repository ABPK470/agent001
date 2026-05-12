/**
 * Identity hook — same contract as classic UI's useMe.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { api } from "./api"
import type { Me } from "./types"

export function useMe() {
  const [me, setMe] = useState<Me | null>(null)
  const [loading, setLoading] = useState(true)

  // Epoch counter: incremented by setIdentity to invalidate any in-flight
  // refresh() response.  React 18 strict-mode double-mounts every effect,
  // so TWO api.me() requests race.  If the slower one resolves AFTER
  // setIdentity, it would overwrite the real identity with "Anonymous",
  // flipping needsWelcome back to true mid-animation.
  const epoch = useRef(0)

  const refresh = useCallback(async () => {
    const v = ++epoch.current
    setLoading(true)
    try {
      const data = await api.me()
      if (epoch.current !== v) return          // stale — discard
      setMe(data)
    } finally {
      if (epoch.current === v) setLoading(false)
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const setIdentity = useCallback(async (displayName: string, upn: string) => {
    ++epoch.current                            // invalidate any in-flight refresh
    const data = await api.setMe(displayName, upn)
    setMe(data)
    setLoading(false)
    return data
  }, [])

  const switchUser = useCallback(async () => {
    await api.clearMe()
    await refresh()
  }, [refresh])

  const needsWelcome = !!me && me.displayName === "Anonymous" && me.upn === null

  return { me, loading, needsWelcome, refresh, setIdentity, switchUser }
}
