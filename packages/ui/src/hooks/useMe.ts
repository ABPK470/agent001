/**
 * useMe — single source of truth for the current session identity.
 *
 * On mount, fetches /api/me. If `displayName` comes back missing/empty
 * (server returned an anonymous fallback), `needsWelcome` flips true
 * so the SPA can pop the welcome modal.
 *
 * After the welcome modal posts to /api/me, callers can refresh().
 */

import { useCallback, useEffect, useRef, useState } from "react"

export interface Me {
  sessionId: string
  displayName: string
  upn: string | null
  isAdmin: boolean
}

export function useMe(): {
  me: Me | null
  loading: boolean
  needsWelcome: boolean
  refresh: () => Promise<void>
  setIdentity: (displayName: string, upn: string) => Promise<Me>
  switchUser: () => Promise<void>
} {
  const [me, setMe] = useState<Me | null>(null)
  const [loading, setLoading] = useState(true)

  // Epoch counter: incremented by setIdentity to invalidate any in-flight
  // refresh() response.  React 18 strict-mode double-mounts every effect,
  // so TWO fetch("/api/me") requests race.  If the slower one resolves
  // AFTER setIdentity, it overwrites the real identity with "Anonymous",
  // flipping needsWelcome back to true mid-animation.
  const epoch = useRef(0)

  const refresh = useCallback(async () => {
    const v = ++epoch.current
    setLoading(true)
    try {
      const res = await fetch("/api/me", { credentials: "include" })
      const data = (await res.json()) as Me
      if (epoch.current !== v) return          // stale — discard
      setMe(data)
    } finally {
      if (epoch.current === v) setLoading(false)
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const setIdentity = useCallback(async (displayName: string, upn: string): Promise<Me> => {
    ++epoch.current                            // invalidate any in-flight refresh
    const res = await fetch("/api/me", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName, upn }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Failed" })) as { error?: string }
      throw new Error(err.error ?? `HTTP ${res.status}`)
    }
    const data = (await res.json()) as Me
    setMe(data)
    setLoading(false)
    return data
  }, [])

  const switchUser = useCallback(async () => {
    await fetch("/api/me/clear", { method: "POST", credentials: "include" })
    await refresh()
  }, [refresh])

  // Treat the anonymous server fallback (displayName === "Anonymous" + null UPN)
  // as "needs welcome modal" — the user hasn't introduced themselves yet.
  const needsWelcome = !!me && me.displayName === "Anonymous" && me.upn === null

  return { me, loading, needsWelcome, refresh, setIdentity, switchUser }
}
