/**
 * Per-tenant concurrency + per-(tenant,domain) rate limits for
 * browser-driven activity.
 *
 * In-process only — keeps state lean and intentionally resets across
 * server restarts (a restart implies the agent's view of the world is
 * gone too). Limits are tunable via env:
 *
 *   MIA_BROWSER_MAX_PER_USER  — concurrent browser sessions per upn (default 2)
 *   MIA_BROWSER_DOMAIN_RPM    — requests per minute per (upn, domain) (default 30)
 *
 * @module
 */

const MAX_PER_USER = Math.max(1, Number(process.env["MIA_BROWSER_MAX_PER_USER"] ?? "2"))
const DOMAIN_RPM = Math.max(1, Number(process.env["MIA_BROWSER_DOMAIN_RPM"] ?? "30"))

// ── Concurrency semaphore ─────────────────────────────────────

const userInFlight = new Map<string, number>()
const userWaitQueues = new Map<string, Array<() => void>>()

export async function acquireUserSlot(ownerUpn: string): Promise<() => void> {
  const current = userInFlight.get(ownerUpn) ?? 0
  if (current < MAX_PER_USER) {
    userInFlight.set(ownerUpn, current + 1)
    return () => releaseUserSlot(ownerUpn)
  }
  // Queue and wait.
  return new Promise<() => void>((resolve) => {
    const queue = userWaitQueues.get(ownerUpn) ?? []
    queue.push(() => resolve(() => releaseUserSlot(ownerUpn)))
    userWaitQueues.set(ownerUpn, queue)
  })
}

function releaseUserSlot(ownerUpn: string): void {
  const queue = userWaitQueues.get(ownerUpn)
  if (queue && queue.length > 0) {
    const next = queue.shift()!
    if (queue.length === 0) userWaitQueues.delete(ownerUpn)
    // Hand the slot directly to the waiter without dec/inc.
    next()
    return
  }
  const n = (userInFlight.get(ownerUpn) ?? 1) - 1
  if (n <= 0) userInFlight.delete(ownerUpn)
  else userInFlight.set(ownerUpn, n)
}

// ── Token bucket per (upn, domain) ────────────────────────────
// Refill rate = DOMAIN_RPM tokens / 60_000 ms. Capacity = DOMAIN_RPM.

interface Bucket {
  tokens: number
  lastRefill: number
}

const buckets = new Map<string, Bucket>()

function bucketKey(ownerUpn: string, host: string): string {
  return `${ownerUpn}\u0000${host.toLowerCase()}`
}

function refill(b: Bucket, now: number): void {
  const dtMs = now - b.lastRefill
  if (dtMs <= 0) return
  const add = (dtMs / 60_000) * DOMAIN_RPM
  b.tokens = Math.min(DOMAIN_RPM, b.tokens + add)
  b.lastRefill = now
}

/**
 * Try to consume one token for the (upn, host) pair. Returns
 * `{allowed: true}` or `{allowed: false, retryAfterMs}`.
 */
export function tryConsumeDomainToken(
  ownerUpn: string,
  host: string,
): { allowed: true } | { allowed: false; retryAfterMs: number } {
  const key = bucketKey(ownerUpn, host)
  const now = Date.now()
  const b = buckets.get(key) ?? { tokens: DOMAIN_RPM, lastRefill: now }
  refill(b, now)
  if (b.tokens >= 1) {
    b.tokens -= 1
    buckets.set(key, b)
    return { allowed: true }
  }
  buckets.set(key, b)
  // Time until 1 full token regenerates.
  const needed = 1 - b.tokens
  const retryAfterMs = Math.ceil((needed / DOMAIN_RPM) * 60_000)
  return { allowed: false, retryAfterMs }
}

/** @internal — for tests. */
export function _resetLimits(): void {
  userInFlight.clear()
  userWaitQueues.clear()
  buckets.clear()
}

/** @internal — for tests. Read current per-user in-flight count. */
export function _userInFlight(ownerUpn: string): number {
  return userInFlight.get(ownerUpn) ?? 0
}

/** Configured limits — exposed for diagnostics + tests. */
export const limitsConfig = {
  maxPerUser: MAX_PER_USER,
  domainRpm: DOMAIN_RPM,
}
