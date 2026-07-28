import { getDb } from "../connection.js"

export interface EffectRow {
  id: string
  run_id: string
  seq: number
  kind: string
  tool: string
  target: string
  pre_hash: string | null
  post_hash: string | null
  status: string
  metadata: string
  created_at: string
}

export interface FileSnapshotRow {
  id: string
  effect_id: string
  run_id: string
  file_path: string
  content: string | null
  hash: string | null
  file_mode: number | null
  created_at: string
}

export function insertEffect(effect: {
  id: string
  runId: string
  seq: number
  kind: string
  tool: string
  target: string
  preHash: string | null
  postHash: string | null
  status: string
  metadata: string
  createdAt: string
}): void {
  getDb()
    .prepare(
      `
      INSERT INTO effects (id, run_id, seq, kind, tool, target, pre_hash, post_hash, status, metadata, created_at)
      VALUES (@id, @run_id, @seq, @kind, @tool, @target, @pre_hash, @post_hash, @status, @metadata, @created_at)
    `
    )
    .run({
      id: effect.id,
      run_id: effect.runId,
      seq: effect.seq,
      kind: effect.kind,
      tool: effect.tool,
      target: effect.target,
      pre_hash: effect.preHash,
      post_hash: effect.postHash,
      status: effect.status,
      metadata: effect.metadata,
      created_at: effect.createdAt
    })
}

export function markEffectCompensated(effectId: string): void {
  getDb().prepare("UPDATE effects SET status = 'compensated' WHERE id = ?").run(effectId)
}

export function listEffectsByRun(runId: string): EffectRow[] {
  return getDb()
    .prepare("SELECT * FROM effects WHERE run_id = ? ORDER BY seq")
    .all(runId) as EffectRow[]
}

export function listEffectsByTarget(filePath: string): EffectRow[] {
  return getDb()
    .prepare("SELECT * FROM effects WHERE target = ? ORDER BY created_at")
    .all(filePath) as EffectRow[]
}

export function insertFileSnapshot(snapshot: {
  id: string
  effectId: string
  runId: string
  filePath: string
  content: string | null
  hash: string | null
  fileMode: number | null
  createdAt: string
}): void {
  getDb()
    .prepare(
      `
    INSERT INTO file_snapshots (id, effect_id, run_id, file_path, content, hash, file_mode, created_at)
    VALUES (@id, @effect_id, @run_id, @file_path, @content, @hash, @file_mode, @created_at)
  `
    )
    .run({
      id: snapshot.id,
      effect_id: snapshot.effectId,
      run_id: snapshot.runId,
      file_path: snapshot.filePath,
      content: snapshot.content,
      hash: snapshot.hash,
      file_mode: snapshot.fileMode,
      created_at: snapshot.createdAt
    })
}

export function getLatestFileSnapshot(filePath: string): FileSnapshotRow | null {
  return (
    (getDb()
      .prepare("SELECT * FROM file_snapshots WHERE file_path = ? ORDER BY created_at DESC LIMIT 1")
      .get(filePath) as FileSnapshotRow | undefined) ?? null
  )
}

export function listFileSnapshotsByRun(runId: string): FileSnapshotRow[] {
  return getDb()
    .prepare("SELECT * FROM file_snapshots WHERE run_id = ? ORDER BY created_at")
    .all(runId) as FileSnapshotRow[]
}

export function getFileSnapshotByEffectId(effectId: string): FileSnapshotRow | null {
  return (
    (getDb()
      .prepare("SELECT * FROM file_snapshots WHERE effect_id = ? LIMIT 1")
      .get(effectId) as FileSnapshotRow | undefined) ?? null
  )
}
