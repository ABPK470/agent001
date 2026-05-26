import { EventType } from "@mia/agent"
import { createHash, randomUUID } from "node:crypto"
import { readFile, stat } from "node:fs/promises"
import { getDb } from "../adapters/persistence/sqlite.js"
import { broadcast } from "../event-broadcaster.js"
import type { Effect, FileSnapshot } from "./types.js"

// ── Hashing utility (also used by tracker and rollback) ──────────

export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex")
}

// ── Snapshots ────────────────────────────────────────────────────

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

  broadcast({
    type: EventType.SnapshotCaptured,
    data: {
      id: snapshot.id,
      effectId: snapshot.effectId,
      runId: snapshot.runId,
      filePath: snapshot.filePath,
      hash: snapshot.hash,
    },
  })

  return snapshot
}

// ── Idempotency detection ────────────────────────────────────────

export async function isIdempotent(effect: Effect): Promise<boolean> {
  if (effect.kind === "command" || effect.kind === "network") return false
  if (!effect.postHash) return false
  try {
    const content = await readFile(effect.target, "utf-8")
    return hashContent(content) === effect.postHash
  } catch {
    return effect.kind === "delete"
  }
}
