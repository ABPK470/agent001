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
 *   - Lives at ${getRunWorkspaceRoot()}/../mia-tool-cache/<upnScope>/
 *   - Scoped by user UPN so tenants cannot poison each other's cache.
 *     `upn="global"` is reserved for admin-curated read-only seeds.
 *   - Each entry has a TTL; expired files are skipped on read and pruned by
 *     `cleanupExpiredCache()` (run alongside the run-workspace TTL sweep).
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
  readonly key: string
  readonly tool: string
  readonly createdAt: string
  readonly expiresAt: string
  readonly value: T
}

function canonicalize(input: unknown): string {
  if (input === null || typeof input !== "object") return JSON.stringify(input)
  if (Array.isArray(input)) return `[${input.map(canonicalize).join(",")}]`
  const obj = input as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`
}

function hashKey(tool: string, input: unknown): string {
  return createHash("sha256")
    .update(`${tool}\u0000${canonicalize(input)}`)
    .digest("hex")
}

function safeUpnDir(upn: string): string {
  const normalized = upn.trim().toLowerCase()
  if (!/^[a-zA-Z0-9._@-]{1,256}$/.test(normalized)) {
    throw new Error(
      `tool-cache: invalid upn ${JSON.stringify(upn)} — callers must supply the authenticated user UPN`
    )
  }
  return normalized.replace(/@/g, "_at_")
}

function entryPath(upn: string, key: string): string {
  return resolve(getToolCacheRoot(), safeUpnDir(upn), `${key}.json`)
}

export async function readCache<T>(opts: {
  tool: string
  input: unknown
  upn: string
}): Promise<T | null> {
  const key = hashKey(opts.tool, opts.input)
  const path = entryPath(opts.upn, key)
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch {
    return null
  }
  let env: CacheEnvelope<T>
  try {
    env = JSON.parse(raw) as CacheEnvelope<T>
  } catch {
    return null
  }
  if (env.key !== key) return null
  if (Date.parse(env.expiresAt) <= Date.now()) return null
  return env.value
}

export async function writeCache<T>(opts: {
  tool: string
  input: unknown
  upn: string
  value: T
  ttlMs?: number
}): Promise<void> {
  const key = hashKey(opts.tool, opts.input)
  const path = entryPath(opts.upn, key)
  await mkdir(dirname(path), { recursive: true })
  const env: CacheEnvelope<T> = {
    key,
    tool: opts.tool,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + (opts.ttlMs ?? DEFAULT_TTL_MS)).toISOString(),
    value: opts.value
  }
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`
  await writeFile(tmp, JSON.stringify(env), { mode: 0o600 })
  await rename(tmp, path)
}

export async function getOrCompute<T>(opts: {
  tool: string
  input: unknown
  upn: string
  ttlMs?: number
  compute: () => Promise<T>
}): Promise<{ value: T; cached: boolean }> {
  const cached = await readCache<T>(opts)
  if (cached !== null) return { value: cached, cached: true }
  const value = await opts.compute()
  try {
    await writeCache({ ...opts, value })
  } catch {
    /* swallow */
  }
  return { value, cached: false }
}

export async function cleanupExpiredCache(): Promise<{ removed: number }> {
  const root = getToolCacheRoot()
  let partitions: string[]
  try {
    partitions = await readdir(root)
  } catch {
    return { removed: 0 }
  }
  const now = Date.now()
  let removed = 0
  for (const partition of partitions) {
    const partitionDir = resolve(root, partition)
    let entries: string[]
    try {
      entries = await readdir(partitionDir)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue
      const path = resolve(partitionDir, entry)
      try {
        const raw = await readFile(path, "utf8")
        const env = JSON.parse(raw) as CacheEnvelope<unknown>
        if (Date.parse(env.expiresAt) <= now) {
          await rm(path, { force: true })
          removed++
        }
      } catch {
        try {
          await rm(path, { force: true })
          removed++
        } catch {
          /* ignore */
        }
      }
    }
    try {
      const left = await readdir(partitionDir)
      if (left.length === 0) await rm(partitionDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
  return { removed }
}

/** Clear the entire cache partition for one user. */
export async function clearUserCache(upn: string): Promise<{ removed: number }> {
  const dir = resolve(getToolCacheRoot(), safeUpnDir(upn))
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return { removed: 0 }
  }
  let removed = 0
  for (const entry of entries) {
    try {
      await rm(resolve(dir, entry), { force: true })
      removed++
    } catch {
      /* ignore */
    }
  }
  try {
    if ((await readdir(dir)).length === 0) await rm(dir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
  return { removed }
}

/** @deprecated Use clearUserCache */
export const clearSessionCache = clearUserCache

export async function getCacheStats(): Promise<{
  users: number
  files: number
  bytes: number
}> {
  const root = getToolCacheRoot()
  let partitions: string[]
  try {
    partitions = await readdir(root)
  } catch {
    return { users: 0, files: 0, bytes: 0 }
  }
  let files = 0
  let bytes = 0
  for (const partition of partitions) {
    const partitionDir = resolve(root, partition)
    let entries: string[]
    try {
      entries = await readdir(partitionDir)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue
      try {
        const s = await stat(resolve(partitionDir, entry))
        files++
        bytes += s.size
      } catch {
        /* ignore */
      }
    }
  }
  return { users: partitions.length, files, bytes }
}
