import {
  getLatestFileSnapshot as getLatestFileSnapshotRow,
  listEffectsByRun,
  listEffectsByTarget,
  listFileSnapshotsByRun,
  type EffectRow,
  type FileSnapshotRow
} from "../persistence/sqlite.js"
import type { Effect, EffectKind, EffectStatus, FileSnapshot } from "./types.js"

function rowToEffect(row: EffectRow): Effect {
  return {
    id: row.id,
    runId: row.run_id,
    seq: row.seq,
    kind: row.kind as EffectKind,
    tool: row.tool,
    target: row.target,
    preHash: row.pre_hash,
    postHash: row.post_hash,
    status: row.status as EffectStatus,
    metadata: JSON.parse(row.metadata ?? "{}"),
    createdAt: row.created_at
  }
}

function rowToSnapshot(row: FileSnapshotRow): FileSnapshot {
  return {
    id: row.id,
    effectId: row.effect_id,
    runId: row.run_id,
    filePath: row.file_path,
    content: row.content,
    hash: row.hash,
    createdAt: row.created_at
  }
}

export function getRunEffects(runId: string): Effect[] {
  return listEffectsByRun(runId).map(rowToEffect)
}

export function getFileHistory(filePath: string): Effect[] {
  return listEffectsByTarget(filePath).map(rowToEffect)
}

export function getLatestSnapshot(filePath: string): FileSnapshot | null {
  const row = getLatestFileSnapshotRow(filePath)
  return row ? rowToSnapshot(row) : null
}

export function getRunSnapshots(runId: string): FileSnapshot[] {
  return listFileSnapshotsByRun(runId).map(rowToSnapshot)
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
    idempotent: effects.filter((e) => e.metadata.idempotent).length
  }
}

/** True when rollback can still compensate at least one file effect. */
export function runHasCompensatableEffects(runId: string): boolean {
  return getRunEffects(runId).some(
    (effect) =>
      (effect.kind === "create" || effect.kind === "modify" || effect.kind === "delete")
      && effect.status !== "compensated",
  )
}
