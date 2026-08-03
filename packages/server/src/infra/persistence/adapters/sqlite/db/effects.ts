import { getPlatformDb } from "../../../schema/kysely.js"
import { runAll, runExec, runGet } from "../../../schema/execute.js"

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
  const compiled = getPlatformDb()
    .insertInto("effects")
    .values({
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
      created_at: effect.createdAt,
    })
    .compile()
  runExec(compiled)
}

export function markEffectCompensated(effectId: string): void {
  const compiled = getPlatformDb()
    .updateTable("effects")
    .set({ status: "compensated" })
    .where("id", "=", effectId)
    .compile()
  runExec(compiled)
}

export function listEffectsByRun(runId: string): EffectRow[] {
  const compiled = getPlatformDb()
    .selectFrom("effects")
    .selectAll()
    .where("run_id", "=", runId)
    .orderBy("seq")
    .compile()
  return runAll<EffectRow>(compiled)
}

export function listEffectsByTarget(filePath: string): EffectRow[] {
  const compiled = getPlatformDb()
    .selectFrom("effects")
    .selectAll()
    .where("target", "=", filePath)
    .orderBy("created_at")
    .compile()
  return runAll<EffectRow>(compiled)
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
  const compiled = getPlatformDb()
    .insertInto("file_snapshots")
    .values({
      id: snapshot.id,
      effect_id: snapshot.effectId,
      run_id: snapshot.runId,
      file_path: snapshot.filePath,
      content: snapshot.content,
      hash: snapshot.hash,
      file_mode: snapshot.fileMode,
      created_at: snapshot.createdAt,
    })
    .compile()
  runExec(compiled)
}

export function getLatestFileSnapshot(filePath: string): FileSnapshotRow | null {
  const compiled = getPlatformDb()
    .selectFrom("file_snapshots")
    .selectAll()
    .where("file_path", "=", filePath)
    .orderBy("created_at", "desc")
    .limit(1)
    .compile()
  return runGet<FileSnapshotRow>(compiled) ?? null
}

export function listFileSnapshotsByRun(runId: string): FileSnapshotRow[] {
  const compiled = getPlatformDb()
    .selectFrom("file_snapshots")
    .selectAll()
    .where("run_id", "=", runId)
    .orderBy("created_at")
    .compile()
  return runAll<FileSnapshotRow>(compiled)
}

export function getFileSnapshotByEffectId(effectId: string): FileSnapshotRow | null {
  const compiled = getPlatformDb()
    .selectFrom("file_snapshots")
    .selectAll()
    .where("effect_id", "=", effectId)
    .limit(1)
    .compile()
  return runGet<FileSnapshotRow>(compiled) ?? null
}
