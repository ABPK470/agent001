import { EventType } from "@mia/agent"
import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { getDb } from "../adapters/persistence/sqlite.js"
import { RollbackActionType } from "../enums/effects.js"
import { broadcast } from "../event-broadcaster.js"
import { getRunEffects } from "./queries.js"
import { hashContent } from "./snapshots.js"
import type { RollbackPreview, RollbackResult } from "./types.js"

// ── Private helpers ──────────────────────────────────────────────

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

// ── Rollback / Compensation ──────────────────────────────────────

export async function rollbackRun(runId: string): Promise<RollbackResult> {
  const preview = await previewRollback(runId)
  if (preview.wouldFail.length > 0) {
    broadcast({
      type: EventType.RollbackBlocked,
      data: { runId, failCount: preview.wouldFail.length, targets: preview.wouldFail.map(f => f.target) },
    })
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

  broadcast({ type: EventType.RollbackStarted, data: { runId, effectCount: getRunEffects(runId).length } })

  const effects = getRunEffects(runId)
  const result: RollbackResult = {
    total: effects.length,
    compensated: 0,
    skipped: 0,
    failed: [],
  }

  const compensatedTargets: string[] = []

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
          compensatedTargets.push(effect.target)
          broadcast({ type: EventType.RollbackEffect, data: { runId, effectId: effect.id, kind: effect.kind, target: effect.target, action: RollbackActionType.Deleted } })
        } else if (currentHash === null) {
          result.skipped++
        }
      } else if (effect.kind === "modify") {
        const snapshotContent = snapshot?.content as string | null ?? null
        if (snapshotContent !== null) {
          await writeFile(effect.target, snapshotContent, "utf-8")
          const fileMode = snapshot?.file_mode as number | null
          if (fileMode != null) {
            await chmod(effect.target, fileMode & 0o7777)
          }
        } else {
          try { await unlink(effect.target) } catch { /* already gone */ }
        }
        markCompensated(effect.id)
        result.compensated++
        compensatedTargets.push(effect.target)
        broadcast({ type: EventType.RollbackEffect, data: { runId, effectId: effect.id, kind: effect.kind, target: effect.target, action: RollbackActionType.Restored } })
      } else if (effect.kind === "delete") {
        if (snapshot) {
          const snapshotContent = snapshot.content as string | null
          if (snapshotContent !== null) {
            await mkdir(dirname(effect.target), { recursive: true })
            await writeFile(effect.target, snapshotContent, "utf-8")
            const fileMode = snapshot.file_mode as number | null
            if (fileMode != null) {
              await chmod(effect.target, fileMode & 0o7777)
            }
            markCompensated(effect.id)
            result.compensated++
            compensatedTargets.push(effect.target)
            broadcast({ type: EventType.RollbackEffect, data: { runId, effectId: effect.id, kind: effect.kind, target: effect.target, action: RollbackActionType.Recreated } })
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

  result.skipped += effects.filter((e) => e.kind === "command" || e.kind === "network").length

  broadcast({
    type: EventType.RollbackCompleted,
    data: {
      runId,
      total: result.total,
      compensated: result.compensated,
      skipped: result.skipped,
      failedCount: result.failed.length,
      targets: compensatedTargets,
    },
  })

  try {
    getDb()
      .prepare(
        `INSERT INTO audit_log (run_id, actor, action, detail, timestamp)
         VALUES (?, 'operator', 'rollback.executed', ?, ?)`,
      )
      .run(
        runId,
        JSON.stringify({
          total: result.total,
          compensated: result.compensated,
          skipped: result.skipped,
          failed: result.failed.length,
          targets: compensatedTargets,
        }),
        new Date().toISOString(),
      )
  } catch {
    // Audit insert is best-effort — don't fail the rollback
  }

  return result
}

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

  for (const e of effects.filter((e) => e.kind === "command" || e.kind === "network")) {
    preview.wouldSkip.push({ effectId: e.id, target: e.target, reason: `${e.kind} effects cannot be rolled back` })
  }

  return preview
}
