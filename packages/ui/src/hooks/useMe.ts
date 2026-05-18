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
 */

import { useCallback, useEffect, useState } from "react"

export interface Me {
  upn: string
  displayName: string
  isAdmin: boolean
}

// Heartbeat interval. The server treats a session as "online" if it has
// been touched within the last 60s (see listUsersWithStats). 30s gives
// us one redundant tick inside that window so a single dropped fetch
// does not flip the user to offline.
const HEARTBEAT_INTERVAL_MS = 30_000

/**
 * Fire a single heartbeat — POST /api/auth/heartbeat. Best-effort: any
 * failure is silently swallowed (network blip, 401 after logout, …);
 * the next tick will retry, and a stable 401 means the user is logged
 * out anyway and will be redirected by the next whoami refresh.
 */
async function sendHeartbeat(): Promise<void> {
  try {
    await fetch("/api/auth/heartbeat", { method: "POST", credentials: "include" })
  } catch { /* swallow — caller never observes failure */ }
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

  // Foreground heartbeat. The server stopped touching last_seen_at on
  // every request (it was bumping it from background SSE / polls so
  // every open tab looked "online" forever); now liveness is driven
  // exclusively by this ping. We only beat while:
  //   - the user is logged in (me != null), AND
  //   - the document is visible (i.e. this tab/window is the one the
  //     user is actually looking at).
  // Switch between two tabs logged in as different users → only the
  // focused tab beats → only that account shows as online. Matches the
  // physical reality of "one human, one foreground at a time".
  useEffect(() => {
    if (!me) return
    let cancelled = false

    const beatIfVisible = (): void => {
      if (cancelled) return
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        void sendHeartbeat()
      }
    }

    // Beat immediately on mount / after login so the user appears online
    // without waiting for the first 30s tick.
    beatIfVisible()
    const interval = window.setInterval(beatIfVisible, HEARTBEAT_INTERVAL_MS)
    // Also beat the moment the tab regains focus — short-circuits the
    // up-to-30s wait when the user alt-tabs back from another window.
    const onVisibilityChange = (): void => beatIfVisible()
    document.addEventListener("visibilitychange", onVisibilityChange)

    return () => {
      cancelled = true
      window.clearInterval(interval)
      document.removeEventListener("visibilitychange", onVisibilityChange)
    }
  }, [me])

  const logout = useCallback(async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST", credentials: "include" })
    } catch { /* even if the network fails, fall through to drop client state */ }
    setMe(null)
  }, [])

  return { me, loading, refresh, logout }
}
