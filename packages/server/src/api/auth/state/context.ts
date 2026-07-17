/**
 * Request/session types plus the per-run AbortController map.
 *
 * The authenticated HTTP boundary decorates `req.session`; downstream code
 * that needs session facts must capture and pass them explicitly.
 *
 * Also hosts the per-run AbortController map; tools register a per-run
 * `AbortSignal` here, and `runWithMssqlKillSignal` (in `@mia/agent`)
 * picks it up via AsyncLocalStorage. The legacy module-global
 * `setMssqlKillSignal()` was deleted in agent Phase 2 — this is the only
 * supported path now.
 */

/**
 * v19: identity is always resolved (no anon). `upn` is the canonical
 * verified user key (FK to users.upn). `displayName` and `isAdmin` come
 * from JOIN with the users table at request time.
 */
export type { CurrentSession } from "../../../ports/session.js"

// ── Per-run kill signals (provided to tools via runWithMssqlKillSignal) ──

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
