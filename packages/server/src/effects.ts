/**
 * Effect Tracking & Compensation.
 *
 * Records every side-effect an agent run produces, enabling:
 *   - Full audit trail of what changed (files, commands, requests)
 *   - Pre-write snapshots for file modifications
 *   - Rollback / compensation — undo all effects of a run
 *   - Idempotency detection — skip effects that already happened
 *
 * Design:
 *   Every write_file, run_command, or fetch_url produces an Effect.
 *   For file writes, we capture a pre-write snapshot (original content + hash).
 *   On rollback, we restore files to their pre-write state.
 */

import { createHash, randomUUID } from "node:crypto"
import { chmod, readFile, stat, unlink, writeFile } from "node:fs/promises"
import { getDb } from "./db.js"

// ── Types ────────────────────────────────────────────────────────

export type EffectKind = "create" | "modify" | "delete" | "command" | "network"
export type EffectStatus = "pending" | "applied" | "compensated" | "skipped"

export interface Effect {
  id: string
  runId: string
  /** Sequential index within the run. */
  seq: number
  /** What kind of side-effect. */
  kind: EffectKind
  /** What tool produced this effect. */
  tool: string
  /** Target (file path, URL, command). */
  target: string
  /** SHA-256 of the target before the effect (null for create). */
  preHash: string | null
  /** SHA-256 of the target after the effect. */
  postHash: string | null
  /** Current status. */
  status: EffectStatus
  /** Extra metadata (command output, response status, etc.). */
  metadata: Record<string, unknown>
  createdAt: string
}

export interface FileSnapshot {
  id: string
  effectId: string
  runId: string
  /** Absolute file path. */
  filePath: string
  /** Original content before the write. Null if file didn't exist. */
  content: string | null
  /** SHA-256 hash of the original content. */
  hash: string | null
  createdAt: string
}

export interface RollbackResult {
  /** Total effects in the run. */
  total: number
  /** Successfully compensated. */
  compensated: number
  /** Skipped (file was already at pre-write state or was never captured). */
  skipped: number
  /** Failed to compensate (file was modified by another run or manually). */
  failed: Array<{ effectId: string; target: string; reason: string }>
}

export interface RollbackPreview {
  /** Effects that would be compensated. */
  wouldCompensate: Array<{ effectId: string; target: string; kind: EffectKind; hasSnapshot: boolean }>
  /** Effects that would be skipped. */
  wouldSkip: Array<{ effectId: string; target: string; reason: string }>
  /** Effects that would fail. */
  wouldFail: Array<{ effectId: string; target: string; reason: string }>
}

// ── Schema migration ─────────────────────────────────────────────

export function migrateEffects(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS effects (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      seq INTEGER NOT NULL DEFAULT 0,
      kind TEXT NOT NULL,
      tool TEXT NOT NULL,
      target TEXT NOT NULL,
      pre_hash TEXT,
      post_hash TEXT,
      status TEXT NOT NULL DEFAULT 'applied',
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_effects_run ON effects(run_id, seq);
    CREATE INDEX IF NOT EXISTS idx_effects_target ON effects(target);

    CREATE TABLE IF NOT EXISTS file_snapshots (
      id TEXT PRIMARY KEY,
      effect_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      content TEXT,
      hash TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (effect_id) REFERENCES effects(id)
    );

    CREATE INDEX IF NOT EXISTS idx_snapshots_run ON file_snapshots(run_id);
    CREATE INDEX IF NOT EXISTS idx_snapshots_effect ON file_snapshots(effect_id);
    CREATE INDEX IF NOT EXISTS idx_snapshots_path ON file_snapshots(file_path);
  `)

  // Add file_mode column if missing (tracks permissions)
  try {
    getDb().exec(`ALTER TABLE file_snapshots ADD COLUMN file_mode INTEGER`)
  } catch {
    // Column already exists
  }
}

// ── Core: record effects ─────────────────────────────────────────

let _seqCounters = new Map<string, number>()

/** Get next sequence number for a run. */
function nextSeq(runId: string): number {
  const current = _seqCounters.get(runId) ?? 0
  _seqCounters.set(runId, current + 1)
  return current
}

/** Reset seq counter (call when run starts). */
export function resetEffectSeq(runId: string): void {
  _seqCounters.delete(runId)
}

/** Record that an effect was applied. */
export function recordEffect(opts: {
  runId: string
  kind: EffectKind
  tool: string
  target: string
  preHash?: string | null
  postHash?: string | null
  metadata?: Record<string, unknown>
}): Effect {
  const now = new Date().toISOString()
  const effect: Effect = {
    id: randomUUID(),
    runId: opts.runId,
    seq: nextSeq(opts.runId),
    kind: opts.kind,
    tool: opts.tool,
    target: opts.target,
    preHash: opts.preHash ?? null,
    postHash: opts.postHash ?? null,
    status: "applied",
    metadata: opts.metadata ?? {},
    createdAt: now,
  }

  getDb().prepare(`
    INSERT INTO effects (id, run_id, seq, kind, tool, target, pre_hash, post_hash, status, metadata, created_at)
    VALUES (@id, @run_id, @seq, @kind, @tool, @target, @pre_hash, @post_hash, @status, @metadata, @created_at)
  `).run({
    ...effect,
    run_id: effect.runId,
    pre_hash: effect.preHash,
    post_hash: effect.postHash,
    metadata: JSON.stringify(effect.metadata),
    created_at: effect.createdAt,
  })

  return effect
}

// ── Core: file snapshots ─────────────────────────────────────────

/**
 * Capture a pre-write snapshot of a file.
 *
 * Call this BEFORE writing to a file. Captures the current content
 * and hash for later rollback.
 *
 * Returns the snapshot and file hash, or null if the file doesn't exist.
 */
export async function captureSnapshot(
  runId: string,
  effectId: string,
  filePath: string,
): Promise<FileSnapshot | null> {
  let content: string | null = null
  let hash: string | null = null

  let fileMode: number | null = null

  try {
    const fileStat = await stat(filePath)
    if (fileStat.isFile()) {
      content = await readFile(filePath, "utf-8")
      hash = hashContent(content)
      fileMode = fileStat.mode
    }
  } catch {
    // File doesn't exist — that's fine, snapshot is null
    return null
  }

  const now = new Date().toISOString()
  const snapshot: FileSnapshot = {
    id: randomUUID(),
    effectId,
    runId,
    filePath,
    content,
    hash,
    createdAt: now,
  }

  getDb().prepare(`
    INSERT INTO file_snapshots (id, effect_id, run_id, file_path, content, hash, file_mode, created_at)
    VALUES (@id, @effect_id, @run_id, @file_path, @content, @hash, @file_mode, @created_at)
  `).run({
    ...snapshot,
    effect_id: snapshot.effectId,
    run_id: snapshot.runId,
    file_path: snapshot.filePath,
    file_mode: fileMode,
    created_at: snapshot.createdAt,
  })

  return snapshot
}

/**
 * Record a file write effect with pre-write snapshot.
 *
 * This is the main integration point — called from the write_file tool wrapper.
 * Captures snapshot → records effect → returns the effect for the tool to proceed.
 */
export async function recordFileWrite(opts: {
  runId: string
  tool: string
  filePath: string
  newContent: string
}): Promise<Effect> {
  // Check idempotency first: if the file already has this content, skip
  const newHash = hashContent(opts.newContent)
  try {
    const existing = await readFile(opts.filePath, "utf-8")
    const existingHash = hashContent(existing)
    if (existingHash === newHash) {
      // Idempotent: file already has this content
      return recordEffect({
        runId: opts.runId,
        kind: "modify",
        tool: opts.tool,
        target: opts.filePath,
        preHash: existingHash,
        postHash: newHash,
        metadata: { idempotent: true, skipped: true },
      })
    }
  } catch {
    // File doesn't exist yet — this will be a "create"
  }

  // Determine kind: create (file doesn't exist) or modify (file exists)
  let kind: EffectKind = "create"
  let preHash: string | null = null
  try {
    await stat(opts.filePath)
    kind = "modify"
    const existing = await readFile(opts.filePath, "utf-8")
    preHash = hashContent(existing)
  } catch {
    // File doesn't exist
  }

  // Record effect first (for the snapshot foreign key)
  const effect = recordEffect({
    runId: opts.runId,
    kind,
    tool: opts.tool,
    target: opts.filePath,
    preHash,
    postHash: newHash,
  })

  // Capture pre-write snapshot
  await captureSnapshot(opts.runId, effect.id, opts.filePath)

  return effect
}

/**
 * Record a file delete effect with pre-delete snapshot.
 *
 * Captures the file's full content and permissions before deletion
 * so it can be restored on rollback.
 */
export async function recordFileDelete(opts: {
  runId: string
  tool: string
  filePath: string
}): Promise<Effect> {
  let preHash: string | null = null
  try {
    const existing = await readFile(opts.filePath, "utf-8")
    preHash = hashContent(existing)
  } catch {
    // File doesn't exist — record a no-op delete
    return recordEffect({
      runId: opts.runId,
      kind: "delete",
      tool: opts.tool,
      target: opts.filePath,
      preHash: null,
      postHash: null,
      metadata: { skipped: true, reason: "file did not exist" },
    })
  }

  // Record effect first (for the snapshot foreign key)
  const effect = recordEffect({
    runId: opts.runId,
    kind: "delete",
    tool: opts.tool,
    target: opts.filePath,
    preHash,
    postHash: null,
  })

  // Capture pre-delete snapshot (content + permissions)
  await captureSnapshot(opts.runId, effect.id, opts.filePath)

  return effect
}

// ── Idempotency detection ────────────────────────────────────────

/**
 * Check if an effect is idempotent — i.e. the target is already
 * in the desired state.
 *
 * For file writes: compare the current file hash with the effect's postHash.
 * For commands: always returns false (commands aren't idempotent by nature).
 */
export async function isIdempotent(effect: Effect): Promise<boolean> {
  if (effect.kind === "command" || effect.kind === "network") return false

  if (!effect.postHash) return false

  try {
    const content = await readFile(effect.target, "utf-8")
    const currentHash = hashContent(content)
    return currentHash === effect.postHash
  } catch {
    // File doesn't exist — only idempotent if the effect was a delete
    return effect.kind === "delete"
  }
}

// ── Rollback / Compensation ──────────────────────────────────────

/**
 * Roll back all file effects for a run.
 *
 * Walks through effects in reverse order and restores files to their
 * pre-write state using captured snapshots.
 *
 * Safety:
 *   - Compensates file create/modify/delete effects
 *   - Checks that the file hasn't been modified by another run/source
 *     since the effect was applied (using hash comparison)
 *   - Restores file permissions when captured in snapshots
 *   - Skips effects that were already compensated
 *   - Does NOT roll back commands or network requests
 *   - Atomic: validates ALL effects before applying ANY changes
 */
export async function rollbackRun(runId: string): Promise<RollbackResult> {
  // Phase 1: validate everything first (dry-run)
  const preview = await previewRollback(runId)
  if (preview.wouldFail.length > 0) {
    // If any effect would fail, abort entirely — atomic guarantee
    return {
      total: preview.wouldCompensate.length + preview.wouldSkip.length + preview.wouldFail.length,
      compensated: 0,
      skipped: preview.wouldSkip.length,
      failed: preview.wouldFail.map((f) => ({
        effectId: f.effectId,
        target: f.target,
        reason: f.reason,
      })),
    }
  }

  // Phase 2: apply all compensations (safe — we validated everything)
  const effects = getRunEffects(runId)
  const result: RollbackResult = {
    total: effects.length,
    compensated: 0,
    skipped: 0,
    failed: [],
  }

  const fileEffects = effects
    .filter((e) => e.kind === "create" || e.kind === "modify" || e.kind === "delete")
    .reverse()

  for (const effect of fileEffects) {
    if (effect.status === "compensated") {
      result.skipped++
      continue
    }

    const snapshot = getDb()
      .prepare("SELECT * FROM file_snapshots WHERE effect_id = ? LIMIT 1")
      .get(effect.id) as Record<string, unknown> | undefined

    try {
      if (effect.kind === "create") {
        const currentHash = await safeFileHash(effect.target)
        if (currentHash === effect.postHash) {
          await unlink(effect.target)
          markCompensated(effect.id)
          result.compensated++
        } else if (currentHash === null) {
          result.skipped++
        }
      } else if (effect.kind === "modify") {
        const snapshotContent = snapshot?.content as string | null ?? null
        if (snapshotContent !== null) {
          await writeFile(effect.target, snapshotContent, "utf-8")
          // Restore permissions if captured
          const fileMode = snapshot?.file_mode as number | null
          if (fileMode != null) {
            await chmod(effect.target, fileMode & 0o7777)
          }
        } else {
          try { await unlink(effect.target) } catch { /* already gone */ }
        }
        markCompensated(effect.id)
        result.compensated++
      } else if (effect.kind === "delete") {
        if (snapshot) {
          const snapshotContent = snapshot.content as string | null
          if (snapshotContent !== null) {
            const { dirname } = await import("node:path")
            const { mkdir } = await import("node:fs/promises")
            await mkdir(dirname(effect.target), { recursive: true })
            await writeFile(effect.target, snapshotContent, "utf-8")
            // Restore permissions if captured
            const fileMode = snapshot.file_mode as number | null
            if (fileMode != null) {
              await chmod(effect.target, fileMode & 0o7777)
            }
            markCompensated(effect.id)
            result.compensated++
          } else {
            result.skipped++
          }
        } else {
          result.skipped++
        }
      }
    } catch (err) {
      result.failed.push({
        effectId: effect.id,
        target: effect.target,
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const nonFileEffects = effects.filter(
    (e) => e.kind === "command" || e.kind === "network",
  )
  result.skipped += nonFileEffects.length

  return result
}

/**
 * Preview what a rollback would do WITHOUT making any changes.
 *
 * Returns categorized lists of effects that would be compensated, skipped, or fail.
 * Use this to show the user a confirmation dialog before committing.
 */
export async function previewRollback(runId: string): Promise<RollbackPreview> {
  const effects = getRunEffects(runId)
  const preview: RollbackPreview = {
    wouldCompensate: [],
    wouldSkip: [],
    wouldFail: [],
  }

  const fileEffects = effects
    .filter((e) => e.kind === "create" || e.kind === "modify" || e.kind === "delete")
    .reverse()

  for (const effect of fileEffects) {
    if (effect.status === "compensated") {
      preview.wouldSkip.push({ effectId: effect.id, target: effect.target, reason: "Already compensated" })
      continue
    }

    const snapshot = getDb()
      .prepare("SELECT * FROM file_snapshots WHERE effect_id = ? LIMIT 1")
      .get(effect.id) as Record<string, unknown> | undefined

    if (effect.kind === "create") {
      const currentHash = await safeFileHash(effect.target)
      if (currentHash === effect.postHash) {
        preview.wouldCompensate.push({ effectId: effect.id, target: effect.target, kind: effect.kind, hasSnapshot: false })
      } else if (currentHash === null) {
        preview.wouldSkip.push({ effectId: effect.id, target: effect.target, reason: "File already deleted" })
      } else {
        preview.wouldFail.push({ effectId: effect.id, target: effect.target, reason: "File was modified after creation by another source" })
      }
    } else if (effect.kind === "modify") {
      if (!snapshot) {
        preview.wouldFail.push({ effectId: effect.id, target: effect.target, reason: "No snapshot available" })
        continue
      }
      const currentHash = await safeFileHash(effect.target)
      if (currentHash !== effect.postHash && currentHash !== null) {
        preview.wouldFail.push({ effectId: effect.id, target: effect.target, reason: "File was modified by another source since this effect" })
      } else {
        preview.wouldCompensate.push({ effectId: effect.id, target: effect.target, kind: effect.kind, hasSnapshot: true })
      }
    } else if (effect.kind === "delete") {
      if (!snapshot || (snapshot.content as string | null) === null) {
        preview.wouldSkip.push({ effectId: effect.id, target: effect.target, reason: "No pre-delete snapshot" })
      } else {
        const currentHash = await safeFileHash(effect.target)
        if (currentHash !== null) {
          preview.wouldFail.push({ effectId: effect.id, target: effect.target, reason: "File was recreated after deletion" })
        } else {
          preview.wouldCompensate.push({ effectId: effect.id, target: effect.target, kind: effect.kind, hasSnapshot: true })
        }
      }
    }
  }

  const nonFileEffects = effects.filter(
    (e) => e.kind === "command" || e.kind === "network",
  )
  for (const e of nonFileEffects) {
    preview.wouldSkip.push({ effectId: e.id, target: e.target, reason: `${e.kind} effects cannot be rolled back` })
  }

  return preview
}

// ── Queries ──────────────────────────────────────────────────────

/** Get all effects for a run, ordered by sequence. */
export function getRunEffects(runId: string): Effect[] {
  const rows = getDb()
    .prepare("SELECT * FROM effects WHERE run_id = ? ORDER BY seq")
    .all(runId) as Array<Record<string, unknown>>
  return rows.map(rowToEffect)
}

/** Get all effects for a given file path across all runs. */
export function getFileHistory(filePath: string): Effect[] {
  const rows = getDb()
    .prepare("SELECT * FROM effects WHERE target = ? ORDER BY created_at")
    .all(filePath) as Array<Record<string, unknown>>
  return rows.map(rowToEffect)
}

/** Get the most recent snapshot for a file. */
export function getLatestSnapshot(filePath: string): FileSnapshot | null {
  const row = getDb()
    .prepare(
      "SELECT * FROM file_snapshots WHERE file_path = ? ORDER BY created_at DESC LIMIT 1",
    )
    .get(filePath) as Record<string, unknown> | undefined
  return row ? rowToSnapshot(row) : null
}

/** Get all snapshots for a run. */
export function getRunSnapshots(runId: string): FileSnapshot[] {
  const rows = getDb()
    .prepare("SELECT * FROM file_snapshots WHERE run_id = ? ORDER BY created_at")
    .all(runId) as Array<Record<string, unknown>>
  return rows.map(rowToSnapshot)
}

/** Get effect statistics for a run. */
export function getEffectStats(runId: string): {
  total: number
  creates: number
  modifies: number
  deletes: number
  commands: number
  network: number
  compensated: number
  idempotent: number
} {
  const effects = getRunEffects(runId)
  return {
    total: effects.length,
    creates: effects.filter((e) => e.kind === "create").length,
    modifies: effects.filter((e) => e.kind === "modify").length,
    deletes: effects.filter((e) => e.kind === "delete").length,
    commands: effects.filter((e) => e.kind === "command").length,
    network: effects.filter((e) => e.kind === "network").length,
    compensated: effects.filter((e) => e.status === "compensated").length,
    idempotent: effects.filter((e) => e.metadata.idempotent).length,
  }
}

// ── Helpers ──────────────────────────────────────────────────────

function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex")
}

async function safeFileHash(filePath: string): Promise<string | null> {
  try {
    const content = await readFile(filePath, "utf-8")
    return hashContent(content)
  } catch {
    return null
  }
}

function markCompensated(effectId: string): void {
  getDb()
    .prepare("UPDATE effects SET status = 'compensated' WHERE id = ?")
    .run(effectId)
}

function rowToEffect(row: Record<string, unknown>): Effect {
  return {
    id: row.id as string,
    runId: row.run_id as string,
    seq: row.seq as number,
    kind: row.kind as EffectKind,
    tool: row.tool as string,
    target: row.target as string,
    preHash: (row.pre_hash as string) ?? null,
    postHash: (row.post_hash as string) ?? null,
    status: row.status as EffectStatus,
    metadata: JSON.parse((row.metadata as string) ?? "{}"),
    createdAt: row.created_at as string,
  }
}

function rowToSnapshot(row: Record<string, unknown>): FileSnapshot {
  return {
    id: row.id as string,
    effectId: row.effect_id as string,
    runId: row.run_id as string,
    filePath: row.file_path as string,
    content: (row.content as string) ?? null,
    hash: (row.hash as string) ?? null,
    createdAt: row.created_at as string,
  }
}
