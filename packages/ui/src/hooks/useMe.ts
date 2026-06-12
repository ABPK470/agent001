/**
 * useMe — single source of truth for the current user.
 *
 * v19: identity is verified via real accounts (auth/users.ts). The hook
 * does ONE thing on mount: GET /api/auth/whoami. If the server returns
 * 401 (no session, expired sid, or revoked user) `me` becomes `null`
 * and the SPA renders <LoginScreen/>. After the login screen posts
 * /api/auth/login or /api/auth/register, it calls `refresh()` to
 * re-pull whoami.
 *
 * The shape of `me` is intentionally minimal — `{upn, displayName,
 * isAdmin}`. There is NO sessionId field: the cookie is opaque and
 * the SPA never reads or threads sid. Every per-user effect dependency
 * collapses to `[me?.upn]` — that's the structural guarantee we paid
 * for in commits 1-4.
 *
 * Liveness ("online" indicator in the Active Users widget) is NOT
 * driven from here. It is a side-effect of the SSE event stream
 * (`/api/events/stream`): while that connection is open the server
 * keeps `sessions.last_seen_at` fresh; when it closes the row ages
 * out within the 60 s online window. No polling endpoint exists.
 */

import { useCallback, useEffect, useState } from "react"

export interface Me {
  upn: string
  displayName: string
  isAdmin: boolean
  /** Widget continuity thread — provisioned server-side at account creation. */
  workspaceThreadId: string
}

export function useMe(): {
  me: Me | null
  loading: boolean
  refresh: () => Promise<void>
  logout: () => Promise<void>
} {
  const [me, setMe] = useState<Me | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch("/api/auth/whoami", { credentials: "include" })
      if (!res.ok) {
        setMe(null)
        return
      }
      const data = (await res.json()) as Me
      setMe(data)
    } catch {
      setMe(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const logout = useCallback(async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST", credentials: "include" })
    } catch { /* even if the network fails, fall through to drop client state */ }
    setMe(null)
  }, [])

  return { me, loading, refresh, logout }
}
