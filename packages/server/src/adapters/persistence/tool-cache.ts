/**
 * Content-addressed tool result cache.
 *
 * Purpose: when a tool produces a deterministic output for a given input
 * (e.g. fetch_url, schema dump, database introspection), the result can be
 * memoised across runs so the agent does not re-pay the latency / cost on
 * every invocation. The cache is keyed by sha256(tool + input) so identical
 * inputs always hit the same file regardless of run id.
 *
 * Lifecycle:
 *   - Lives at ${getRunWorkspaceRoot()}/../mia-tool-cache/<sessionScope>/
 *     i.e. completely OUTSIDE the per-run sandbox so it survives sandbox
 *     teardown at run completion.
 *   - Scoped by sessionId so two browser sessions cannot poison each other.
 *     `sessionId="global"` is reserved for admin-curated read-only seeds.
 *   - Each entry has a TTL; expired files are skipped on read and pruned by
 *     `cleanupExpiredCache()` (run alongside the run-workspace TTL sweep).
 *   - Read-only mount semantics: callers receive a deep-frozen object; the
 *     filesystem entry is written atomically via tmp + rename.
 *
 * Tools opt in by calling `getOrCompute(...)`. No tool is auto-cached \u2014
 * the deterministic-output decision is the tool author's responsibility.
 */

import { createHash } from "node:crypto"
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, resolve } from "node:path"

const CACHE_ROOT_NAME = "mia-tool-cache"

export function getToolCacheRoot(): string {
  return resolve(tmpdir(), CACHE_ROOT_NAME)
}

/** Default TTL: 1 hour. Tools may override per-call. */
const DEFAULT_TTL_MS = 60 * 60 * 1000

interface CacheEnvelope<T> {
  /** SHA-256 of (toolName + canonical(input)). */
  readonly key: string
  /** Tool name that produced this entry (audit trail). */
  readonly tool: string
  /** ISO timestamp when the entry was written. */
  readonly createdAt: string
  /** ISO timestamp after which the entry is treated as missing. */
  readonly expiresAt: string
  /** Deterministic tool output. */
  readonly value: T
}

function canonicalize(input: unknown): string {
  // Stable JSON: sort object keys recursively so { a: 1, b: 2 } and
  // { b: 2, a: 1 } produce the same hash. Arrays preserve order (semantically
  // significant for most tool inputs).
  if (input === null || typeof input !== "object") return JSON.stringify(input)
  if (Array.isArray(input)) return `[${input.map(canonicalize).join(",")}]`
  const obj = input as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`
}

function hashKey(tool: string, input: unknown): string {
  return createHash("sha256").update(`${tool}\u0000${canonicalize(input)}`).digest("hex")
}

function safeSessionDir(sessionId: string): string {
  // Reject path-traversal characters — the cache partition is a trust boundary
  // and a malicious sessionId of the form "../another-user" must not escape
  // this user's directory. Empty / non-conforming ids fail loudly: identity.ts
  // guarantees every request carries a non-empty sid, so callers receiving
  // null/empty here are buggy and we surface that instead of silently sharing
  // an "anonymous" partition across all anon callers (the bug class fixed in
  // wiring-contracts.test.ts B-AUDIT).
  if (!/^[a-zA-Z0-9._-]{1,128}$/.test(sessionId)) {
    throw new Error(
      `tool-cache: invalid sessionId ${JSON.stringify(sessionId)} — callers must supply a non-empty per-session identifier (e.g. req.session.sid)`,
    )
  }
  return sessionId
}

function entryPath(sessionId: string, key: string): string {
  return resolve(getToolCacheRoot(), safeSessionDir(sessionId), `${key}.json`)
}

/**
 * Look up a cached entry. Returns the value if present and unexpired,
 * otherwise null. Callers should prefer `getOrCompute()` for the common case.
 */
export async function readCache<T>(opts: {
  tool: string
  input: unknown
  sessionId: string
}): Promise<T | null> {
  const key = hashKey(opts.tool, opts.input)
  const path = entryPath(opts.sessionId, key)
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch {
    return null
  }
  let env: CacheEnvelope<T>
  try { env = JSON.parse(raw) as CacheEnvelope<T> } catch { return null }
  if (env.key !== key) return null
  if (Date.parse(env.expiresAt) <= Date.now()) return null
  return env.value
}

/**
 * Write a value to the cache. The file is staged at <path>.tmp and renamed
 * atomically so a crashed write never leaves a partial entry on disk.
 */
export async function writeCache<T>(opts: {
  tool: string
  input: unknown
  sessionId: string
  value: T
  ttlMs?: number
}): Promise<void> {
  const key = hashKey(opts.tool, opts.input)
  const path = entryPath(opts.sessionId, key)
  await mkdir(dirname(path), { recursive: true })
  const env: CacheEnvelope<T> = {
    key,
    tool: opts.tool,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + (opts.ttlMs ?? DEFAULT_TTL_MS)).toISOString(),
    value: opts.value,
  }
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`
  await writeFile(tmp, JSON.stringify(env), { mode: 0o600 })
  await rename(tmp, path)
}

/**
 * Convenience wrapper: read from cache, otherwise call `compute()` and
 * persist the result. The cache stores ONLY successful computations; if
 * `compute()` throws, the error propagates without polluting the cache.
 */
export async function getOrCompute<T>(opts: {
  tool: string
  input: unknown
  sessionId: string
  ttlMs?: number
  compute: () => Promise<T>
}): Promise<{ value: T; cached: boolean }> {
  const cached = await readCache<T>(opts)
  if (cached !== null) return { value: cached, cached: true }
  const value = await opts.compute()
  // Best-effort write \u2014 a cache write failure must not break the tool call.
  try { await writeCache({ ...opts, value }) } catch { /* swallow */ }
  return { value, cached: false }
}

/**
 * Remove expired entries across all sessions. Intended to be called by the
 * orchestrator alongside `cleanupStaleRunWorkspaces()` so the cache does not
 * grow without bound.
 */
export async function cleanupExpiredCache(): Promise<{ removed: number }> {
  const root = getToolCacheRoot()
  let removed = 0
  let sessions: string[]
  try {
    sessions = await readdir(root)
  } catch {
    return { removed: 0 }
  }
  const now = Date.now()
  for (const session of sessions) {
    const sessionDir = resolve(root, session)
    let entries: string[]
    try { entries = await readdir(sessionDir) } catch { continue }
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue
      const path = resolve(sessionDir, entry)
      try {
        const raw = await readFile(path, "utf8")
        const env = JSON.parse(raw) as CacheEnvelope<unknown>
        if (Date.parse(env.expiresAt) <= now) {
          await rm(path, { force: true })
          removed++
        }
      } catch {
        // Unreadable / corrupt \u2014 best-effort delete to keep the dir tidy.
        try { await rm(path, { force: true }) ; removed++ } catch { /* ignore */ }
      }
    }
    // Drop empty session directories so a churning user does not leave
    // hundreds of empty dirs behind.
    try {
      const left = await readdir(sessionDir)
      if (left.length === 0) await rm(sessionDir, { recursive: true, force: true })
    } catch { /* ignore */ }
  }
  return { removed }
}

/**
 * Clear the entire cache for a single session. Used by the admin "clear
 * cache" endpoint and by tests.
 */
export async function clearSessionCache(sessionId: string): Promise<{ removed: number }> {
  const dir = resolve(getToolCacheRoot(), safeSessionDir(sessionId))
  let entries: string[]
  try { entries = await readdir(dir) } catch { return { removed: 0 } }
  let removed = 0
  for (const entry of entries) {
    try { await rm(resolve(dir, entry), { force: true }) ; removed++ } catch { /* ignore */ }
  }
  try {
    if ((await readdir(dir)).length === 0) await rm(dir, { recursive: true, force: true })
  } catch { /* ignore */ }
  return { removed }
}

/**
 * Disk usage stats per session \u2014 useful for observability and quota work.
 */
export async function getCacheStats(): Promise<{
  sessions: number
  files: number
  bytes: number
}> {
  const root = getToolCacheRoot()
  let sessions: string[]
  try { sessions = await readdir(root) } catch { return { sessions: 0, files: 0, bytes: 0 } }
  let files = 0
  let bytes = 0
  for (const session of sessions) {
    const sessionDir = resolve(root, session)
    let entries: string[]
    try { entries = await readdir(sessionDir) } catch { continue }
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue
      try {
        const s = await stat(resolve(sessionDir, entry))
        files++
        bytes += s.size
      } catch { /* ignore */ }
    }
  }
  return { sessions: sessions.length, files, bytes }
}
