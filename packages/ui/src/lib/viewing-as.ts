/**
 * Viewing as — chrome-owned Personal data scope (doctrine §5b).
 *
 * Invariant: `store.target` is null (Me) XOR an admin is viewing another UPN.
 * Never persist “viewing as myself”. Never leave admin scope in memory after
 * logout or when a non-admin session binds — that leaked into chat read-only
 * and Viewing as ASCII for operators.
 *
 * null = Me (signed-in session). Admins may set another user’s UPN.
 * Widgets read isViewingAsOther for quiet chrome only — never own scope,
 * never take userId props. The HTTP client attaches X-Viewing-As.
 */

const STORAGE_PREFIX = "mia.viewingAs:"

export type ViewingAsTarget = {
  upn: string
  displayName: string
}

export type ViewingAsSession = {
  upn: string
  isAdmin: boolean
}

type Listener = () => void

type ViewingAsStore = {
  target: ViewingAsTarget | null
  /** Last bound session UPN — used to treat self-target as Me. */
  sessionUpn: string | null
  listeners: Set<Listener>
}

/** Single store — allowlisted module state (shell chrome scope, not Host/Run). */
const store: ViewingAsStore = {
  target: null,
  sessionUpn: null,
  listeners: new Set(),
}

function sameUpn(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const left = a?.trim().toLowerCase()
  const right = b?.trim().toLowerCase()
  return Boolean(left && right && left === right)
}

function storageKey(sessionUpn: string): string {
  return `${STORAGE_PREFIX}${sessionUpn.trim().toLowerCase()}`
}

function notify(): void {
  for (const listener of store.listeners) listener()
}

function writeSession(sessionUpn: string | undefined, next: ViewingAsTarget | null): void {
  if (!sessionUpn?.trim()) return
  try {
    const key = storageKey(sessionUpn)
    if (next) sessionStorage.setItem(key, JSON.stringify(next))
    else sessionStorage.removeItem(key)
  } catch (err) {
    console.warn("[mia] Viewing as sessionStorage unavailable", err)
  }
}

function normalizeTarget(
  next: ViewingAsTarget | null,
  sessionUpn: string | null | undefined,
): ViewingAsTarget | null {
  if (!next?.upn?.trim()) return null
  const upn = next.upn.trim()
  if (sessionUpn && sameUpn(upn, sessionUpn)) return null
  return {
    upn,
    displayName: next.displayName.trim() || upn,
  }
}

/** UPN for Personal requests, or null when Viewing as Me (omit header). */
export function getViewingAsUpn(): string | null {
  const target = store.target
  if (!target) return null
  if (store.sessionUpn && sameUpn(target.upn, store.sessionUpn)) return null
  return target.upn
}

/** EventSource cannot set headers — attach ?viewingAs= (omit when Me). */
export function attachViewingAsQuery(url: string): string {
  const viewingAs = getViewingAsUpn()
  if (!viewingAs) return url
  const sep = url.includes("?") ? "&" : "?"
  return `${url}${sep}viewingAs=${encodeURIComponent(viewingAs)}`
}

export function getViewingAsTarget(): ViewingAsTarget | null {
  if (!getViewingAsUpn()) return null
  return store.target
}

export function isViewingAsMe(): boolean {
  return getViewingAsUpn() === null
}

export function isViewingAsOther(): boolean {
  return !isViewingAsMe()
}

export function setViewingAs(next: ViewingAsTarget | null, sessionUpn?: string): void {
  const session = sessionUpn?.trim() || store.sessionUpn
  const normalized = normalizeTarget(next, session)
  const prev = getViewingAsUpn()
  const nextUpn = normalized?.upn ?? null
  const prevName = store.target?.displayName ?? null
  const nextName = normalized?.displayName ?? null
  if (prev === nextUpn && prevName === nextName) {
    if (session) store.sessionUpn = session
    return
  }
  store.target = normalized
  if (session) store.sessionUpn = session
  writeSession(session ?? undefined, store.target)
  notify()
}

/**
 * Bind chrome to the signed-in session.
 * Operators always Me. Admins restore persisted target (never self).
 */
export function syncViewingAsForSession(session: ViewingAsSession): void {
  const upn = session.upn.trim()
  if (!upn) {
    resetViewingAsMemory()
    return
  }
  store.sessionUpn = upn

  if (!session.isAdmin) {
    // Drop leftover admin scope from this tab — do not touch other users' keys.
    if (store.target !== null) {
      store.target = null
      notify()
    }
    return
  }

  restoreViewingAs(upn)
}

/** Restore persisted Viewing as for this signed-in admin (after me loads). */
export function restoreViewingAs(sessionUpn: string): void {
  const upn = sessionUpn.trim()
  store.sessionUpn = upn || store.sessionUpn
  try {
    const raw = upn ? sessionStorage.getItem(storageKey(upn)) : null
    if (!raw) {
      if (store.target !== null) {
        store.target = null
        notify()
      }
      return
    }
    const parsed = JSON.parse(raw) as ViewingAsTarget
    const normalized = normalizeTarget(
      typeof parsed?.upn === "string"
        ? {
            upn: parsed.upn,
            displayName: typeof parsed.displayName === "string" ? parsed.displayName : parsed.upn,
          }
        : null,
      upn,
    )
    if (store.target?.upn === normalized?.upn
      && store.target?.displayName === normalized?.displayName) {
      if (!normalized) writeSession(upn, null)
      return
    }
    store.target = normalized
    if (!normalized) writeSession(upn, null)
    notify()
  } catch (err) {
    console.warn("[mia] Viewing as restore failed", err)
    store.target = null
    notify()
  }
}

export function clearViewingAs(sessionUpn?: string): void {
  setViewingAs(null, sessionUpn)
}

/** Logout / unsigned — wipe memory only (admin sessionStorage may remain for next login). */
export function resetViewingAsMemory(): void {
  const changed = store.target !== null || store.sessionUpn !== null
  store.target = null
  store.sessionUpn = null
  if (changed) notify()
}

export function subscribeViewingAs(listener: Listener): () => void {
  store.listeners.add(listener)
  return () => {
    store.listeners.delete(listener)
  }
}
