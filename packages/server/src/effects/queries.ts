import { getDb } from "../db.js"
import type { Effect, EffectKind, EffectStatus, FileSnapshot } from "./types.js"

// ── Row mappers (module-private) ─────────────────────────────────

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

// ── Queries ──────────────────────────────────────────────────────

export function getRunEffects(runId: string): Effect[] {
  const rows = getDb()
    .prepare("SELECT * FROM effects WHERE run_id = ? ORDER BY seq")
    .all(runId) as Array<Record<string, unknown>>
  return rows.map(rowToEffect)
}

export function getFileHistory(filePath: string): Effect[] {
  const rows = getDb()
    .prepare("SELECT * FROM effects WHERE target = ? ORDER BY created_at")
    .all(filePath) as Array<Record<string, unknown>>
  return rows.map(rowToEffect)
}

export function getLatestSnapshot(filePath: string): FileSnapshot | null {
  const row = getDb()
    .prepare("SELECT * FROM file_snapshots WHERE file_path = ? ORDER BY created_at DESC LIMIT 1")
    .get(filePath) as Record<string, unknown> | undefined
  return row ? rowToSnapshot(row) : null
}

export function getRunSnapshots(runId: string): FileSnapshot[] {
  const rows = getDb()
    .prepare("SELECT * FROM file_snapshots WHERE run_id = ? ORDER BY created_at")
    .all(runId) as Array<Record<string, unknown>>
  return rows.map(rowToSnapshot)
}

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
