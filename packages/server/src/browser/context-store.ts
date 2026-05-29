/**
 * Per-tenant browser context store.
 *
 * Persists Playwright `storageState` (cookies + localStorage + IndexedDB
 * snapshots) under `~/.mia/browser-contexts/<id>.json` so the agent can
 * stay logged in across runs / restarts. Anonymous sessions get NO row
 * and NO file — their state lives only in memory and is dropped when the
 * browser session times out.
 *
 * Tenant boundary = `upn`. There is exactly one persistent context per
 * upn (UNIQUE index in the schema). The fingerprint seed is captured on
 * first use and reused thereafter so the same user always looks like the
 * same machine.
 *
 * @module
 */

import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

import { getDb } from "../adapters/persistence/sqlite.js"

const DATA_DIR = process.env["MIA_DATA_DIR"] || join(homedir(), ".mia")
const CONTEXTS_DIR = join(DATA_DIR, "browser-contexts")

function ensureDir(): void {
  if (!existsSync(CONTEXTS_DIR)) mkdirSync(CONTEXTS_DIR, { recursive: true })
}

export interface BrowserContextRecord {
  id: string
  ownerUpn: string
  storagePath: string // absolute path to JSON file
  fingerprintSeed: string
}

interface Row {
  id: string
  owner_upn: string
  storage_path: string
  fingerprint_seed: string
}

/**
 * Look up or create the persistent context row for an upn. Does NOT
 * touch the filesystem; the caller is responsible for `loadStorageState`
 * and `saveStorageState`.
 */
export function getOrCreateContext(ownerUpn: string): BrowserContextRecord {
  ensureDir()
  const db = getDb()

  const existing = db
    .prepare("SELECT id, owner_upn, storage_path, fingerprint_seed FROM browser_contexts WHERE owner_upn = ?")
    .get(ownerUpn) as Row | undefined

  if (existing) {
    db.prepare("UPDATE browser_contexts SET last_used_at = datetime('now') WHERE id = ?").run(existing.id)
    return {
      id: existing.id,
      ownerUpn: existing.owner_upn,
      storagePath: join(CONTEXTS_DIR, existing.storage_path),
      fingerprintSeed: existing.fingerprint_seed,
    }
  }

  const id = randomUUID()
  const fileName = `${id}.json`
  const seed = ownerUpn // deterministic per-tenant by default
  db.prepare(
    `INSERT INTO browser_contexts (id, owner_upn, storage_path, fingerprint_seed)
     VALUES (?, ?, ?, ?)`,
  ).run(id, ownerUpn, fileName, seed)

  return {
    id,
    ownerUpn,
    storagePath: join(CONTEXTS_DIR, fileName),
    fingerprintSeed: seed,
  }
}

/**
 * Read the storage state JSON for a context, or null if no file exists yet.
 * Playwright accepts the parsed object directly under `newContext({ storageState })`.
 */
export async function loadStorageState(record: BrowserContextRecord): Promise<unknown | null> {
  try {
    const text = await readFile(record.storagePath, "utf8")
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * Persist the latest storage state for a context. Atomic write via temp +
 * rename so a crashed save does not corrupt the file.
 */
export async function saveStorageState(record: BrowserContextRecord, state: unknown): Promise<void> {
  ensureDir()
  const tmp = `${record.storagePath}.tmp-${process.pid}`
  await writeFile(tmp, JSON.stringify(state), { encoding: "utf8", mode: 0o600 })
  // Use rename via fs/promises
  const { rename } = await import("node:fs/promises")
  await rename(tmp, record.storagePath)
  getDb()
    .prepare("UPDATE browser_contexts SET last_used_at = datetime('now') WHERE id = ?")
    .run(record.id)
}

/**
 * List browser contexts. Without an owner argument lists all (admin/tests
 * only). Pass `ownerUpn` to scope to a single tenant — the only safe
 * variant for end-user APIs.
 */
export function listContexts(ownerUpn?: string): BrowserContextRecord[] {
  const sql = ownerUpn
    ? "SELECT id, owner_upn, storage_path, fingerprint_seed FROM browser_contexts WHERE owner_upn = ? ORDER BY last_used_at DESC"
    : "SELECT id, owner_upn, storage_path, fingerprint_seed FROM browser_contexts ORDER BY last_used_at DESC"
  const stmt = getDb().prepare(sql)
  const rows = (ownerUpn ? stmt.all(ownerUpn) : stmt.all()) as Row[]
  return rows.map((r) => ({
    id: r.id,
    ownerUpn: r.owner_upn,
    storagePath: join(CONTEXTS_DIR, r.storage_path),
    fingerprintSeed: r.fingerprint_seed,
  }))
}
