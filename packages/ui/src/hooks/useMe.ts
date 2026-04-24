/**
 * useMe — single source of truth for the current session identity.
 *
 * On mount, fetches /api/me. If `displayName` comes back missing/empty
 * (server returned an anonymous fallback), `needsWelcome` flips true
 * so the SPA can pop the welcome modal.
 *
 * After the welcome modal posts to /api/me, callers can refresh().
 */

import { useCallback, useEffect, useState } from "react"

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

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch("/api/me", { credentials: "include" })
      const data = (await res.json()) as Me
      setMe(data)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const setIdentity = useCallback(async (displayName: string, upn: string): Promise<Me> => {
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
