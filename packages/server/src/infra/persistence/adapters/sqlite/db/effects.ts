import { getPlatformDb } from "../../../schema/kysely.js"
import { runAllAsync, runExecAsync, runGetAsync } from "../../../schema/execute-async.js"

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

export async function insertEffect(effect: {
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
}): Promise<void> {
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
  await runExecAsync(compiled)
}

export async function markEffectCompensated(effectId: string): Promise<void> {
  const compiled = getPlatformDb()
    .updateTable("effects")
    .set({ status: "compensated" })
    .where("id", "=", effectId)
    .compile()
  await runExecAsync(compiled)
}

export async function listEffectsByRun(runId: string): Promise<EffectRow[]> {
  const compiled = getPlatformDb()
    .selectFrom("effects")
    .selectAll()
    .where("run_id", "=", runId)
    .orderBy("seq")
    .compile()
  return await runAllAsync<EffectRow>(compiled)
}

export async function listEffectsByTarget(filePath: string): Promise<EffectRow[]> {
  const compiled = getPlatformDb()
    .selectFrom("effects")
    .selectAll()
    .where("target", "=", filePath)
    .orderBy("created_at")
    .compile()
  return await runAllAsync<EffectRow>(compiled)
}

export async function insertFileSnapshot(snapshot: {
  id: string
  effectId: string
  runId: string
  filePath: string
  content: string | null
  hash: string | null
  fileMode: number | null
  createdAt: string
}): Promise<void> {
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
  await runExecAsync(compiled)
}

export async function getLatestFileSnapshot(filePath: string): Promise<FileSnapshotRow | null> {
  const compiled = getPlatformDb()
    .selectFrom("file_snapshots")
    .selectAll()
    .where("file_path", "=", filePath)
    .orderBy("created_at", "desc")
    .limit(1)
    .compile()
  return await runGetAsync<FileSnapshotRow>(compiled) ?? null
}

export async function listFileSnapshotsByRun(runId: string): Promise<FileSnapshotRow[]> {
  const compiled = getPlatformDb()
    .selectFrom("file_snapshots")
    .selectAll()
    .where("run_id", "=", runId)
    .orderBy("created_at")
    .compile()
  return await runAllAsync<FileSnapshotRow>(compiled)
}

export async function getFileSnapshotByEffectId(effectId: string): Promise<FileSnapshotRow | null> {
  const compiled = getPlatformDb()
    .selectFrom("file_snapshots")
    .selectAll()
    .where("effect_id", "=", effectId)
    .limit(1)
    .compile()
  return await runGetAsync<FileSnapshotRow>(compiled) ?? null
}
