/**
 * Viewing as — app-owned Personal data scope.
 *
 * null = Me (signed-in session). Admins may set another user’s UPN.
 * Widgets do not take userId props; the HTTP client attaches X-Viewing-As.
 */

const STORAGE_PREFIX = "mia.viewingAs:"

export type ViewingAsTarget = {
  upn: string
  displayName: string
}

type Listener = () => void

let target: ViewingAsTarget | null = null
const listeners = new Set<Listener>()

function storageKey(sessionUpn: string): string {
  return `${STORAGE_PREFIX}${sessionUpn.trim().toLowerCase()}`
}

function notify(): void {
  for (const listener of listeners) listener()
}

/** UPN for Personal requests, or null when Viewing as Me. */
export function getViewingAsUpn(): string | null {
  return target?.upn ?? null
}

export function getViewingAsTarget(): ViewingAsTarget | null {
  return target
}

export function isViewingAsMe(): boolean {
  return target === null
}

export function setViewingAs(next: ViewingAsTarget | null, sessionUpn?: string): void {
  const prev = target?.upn ?? null
  const nextUpn = next?.upn ?? null
  if (prev === nextUpn && (target?.displayName ?? null) === (next?.displayName ?? null)) {
    return
  }
  target = next
    ? { upn: next.upn.trim(), displayName: next.displayName.trim() || next.upn.trim() }
    : null

  if (sessionUpn?.trim()) {
    try {
      const key = storageKey(sessionUpn)
      if (target) sessionStorage.setItem(key, JSON.stringify(target))
      else sessionStorage.removeItem(key)
    } catch {
      /* ignore quota / private mode */
    }
  }

  notify()
}

/** Restore persisted Viewing as for this signed-in admin (call after me loads). */
export function restoreViewingAs(sessionUpn: string): void {
  try {
    const raw = sessionStorage.getItem(storageKey(sessionUpn))
    if (!raw) {
      target = null
      notify()
      return
    }
    const parsed = JSON.parse(raw) as ViewingAsTarget
    if (typeof parsed?.upn === "string" && parsed.upn.trim()) {
      target = {
        upn: parsed.upn.trim(),
        displayName: typeof parsed.displayName === "string" && parsed.displayName.trim()
          ? parsed.displayName.trim()
          : parsed.upn.trim(),
      }
    } else {
      target = null
    }
  } catch {
    target = null
  }
  notify()
}

export function clearViewingAs(sessionUpn?: string): void {
  setViewingAs(null, sessionUpn)
}

export function subscribeViewingAs(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
