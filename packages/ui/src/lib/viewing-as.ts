/**
 * Viewing as — chrome-owned Personal data scope (doctrine §5b).
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

type Listener = () => void

type ViewingAsStore = {
  target: ViewingAsTarget | null
  listeners: Set<Listener>
}

/** Single store — allowlisted module state (shell chrome scope, not Host/Run). */
const store: ViewingAsStore = {
  target: null,
  listeners: new Set(),
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

/** UPN for Personal requests, or null when Viewing as Me. */
export function getViewingAsUpn(): string | null {
  return store.target?.upn ?? null
}

/** EventSource cannot set headers — attach ?viewingAs= (omit when Me). */
export function attachViewingAsQuery(url: string): string {
  const viewingAs = getViewingAsUpn()
  if (!viewingAs) return url
  const sep = url.includes("?") ? "&" : "?"
  return `${url}${sep}viewingAs=${encodeURIComponent(viewingAs)}`
}

export function getViewingAsTarget(): ViewingAsTarget | null {
  return store.target
}

export function isViewingAsMe(): boolean {
  return store.target === null
}

export function setViewingAs(next: ViewingAsTarget | null, sessionUpn?: string): void {
  const prev = store.target?.upn ?? null
  const nextUpn = next?.upn ?? null
  if (prev === nextUpn && (store.target?.displayName ?? null) === (next?.displayName ?? null)) {
    return
  }
  store.target = next
    ? { upn: next.upn.trim(), displayName: next.displayName.trim() || next.upn.trim() }
    : null

  writeSession(sessionUpn, store.target)
  notify()
}

/** Restore persisted Viewing as for this signed-in admin (call after me loads). */
export function restoreViewingAs(sessionUpn: string): void {
  try {
    const raw = sessionStorage.getItem(storageKey(sessionUpn))
    if (!raw) {
      store.target = null
      notify()
      return
    }
    const parsed = JSON.parse(raw) as ViewingAsTarget
    if (typeof parsed?.upn === "string" && parsed.upn.trim()) {
      store.target = {
        upn: parsed.upn.trim(),
        displayName: typeof parsed.displayName === "string" && parsed.displayName.trim()
          ? parsed.displayName.trim()
          : parsed.upn.trim(),
      }
    } else {
      store.target = null
    }
  } catch (err) {
    console.warn("[mia] Viewing as restore failed", err)
    store.target = null
  }
  notify()
}

export function clearViewingAs(sessionUpn?: string): void {
  setViewingAs(null, sessionUpn)
}

export function subscribeViewingAs(listener: Listener): () => void {
  store.listeners.add(listener)
  return () => {
    store.listeners.delete(listener)
  }
}
