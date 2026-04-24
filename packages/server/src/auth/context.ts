/**
 * AsyncLocalStorage session context — lets deep code (db helpers, tools,
 * loggers) read the current request's session without explicit threading.
 *
 * Every HTTP request runs inside `als.run({ session }, handler)`. Anywhere
 * downstream, `getCurrentSession()` returns the session or null.
 *
 * Also hosts the per-run AbortController map, replacing the dangerous
 * module-level `setMssqlKillSignal()` global. (Hooked up in a later phase.)
 */

import { AsyncLocalStorage } from "node:async_hooks"

export interface CurrentSession {
  sid: string
  displayName: string
  upn: string | null
  isAdmin: boolean
  ip: string
  userAgent: string
}

/** @internal — exported so the request hook can call enterWith(). Use getCurrentSession() instead in app code. */
export const sessionAls = new AsyncLocalStorage<{ session: CurrentSession }>()

export function runWithSession<T>(session: CurrentSession, fn: () => T): T {
  return sessionAls.run({ session }, fn)
}

export function getCurrentSession(): CurrentSession | null {
  return sessionAls.getStore()?.session ?? null
}

// ── Per-run kill signals (replaces module-global setMssqlKillSignal) ──

const runSignals = new Map<string, AbortController>()

export function registerRunSignal(runId: string): AbortController {
  const ac = new AbortController()
  runSignals.set(runId, ac)
  return ac
}

export function getRunSignal(runId: string): AbortSignal | undefined {
  return runSignals.get(runId)?.signal
}

export function killRun(runId: string): boolean {
  const ac = runSignals.get(runId)
  if (!ac) return false
  ac.abort()
  return true
}

export function clearRunSignal(runId: string): void {
  runSignals.delete(runId)
}
