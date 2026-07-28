import { EventType } from "@mia/agent"
import { randomUUID } from "node:crypto"
import { readFile, stat } from "node:fs/promises"
import { insertEffect as insertEffectRow } from "../persistence/sqlite.js"
import { EffectKind, EffectStatus } from "../../internal/enums/effects.js"
import { broadcast } from "../events/broadcaster.js"
import { captureSnapshot, hashContent } from "./snapshots.js"
import type { Effect } from "./types.js"

// ── EffectTracker (stateful — holds per-run sequence counters) ───

export class EffectTracker {
  private seqCounters = new Map<string, number>()

  private nextSeq(runId: string): number {
    const current = this.seqCounters.get(runId) ?? 0
    this.seqCounters.set(runId, current + 1)
    return current
  }

  resetEffectSeq(runId: string): void {
    this.seqCounters.delete(runId)
  }

  recordEffect(opts: {
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
      seq: this.nextSeq(opts.runId),
      kind: opts.kind,
      tool: opts.tool,
      target: opts.target,
      preHash: opts.preHash ?? null,
      postHash: opts.postHash ?? null,
      status: EffectStatus.Applied,
      metadata: opts.metadata ?? {},
      createdAt: now
    }

    insertEffectRow({
      id: effect.id,
      runId: effect.runId,
      seq: effect.seq,
      kind: effect.kind,
      tool: effect.tool,
      target: effect.target,
      preHash: effect.preHash,
      postHash: effect.postHash,
      status: effect.status,
      metadata: JSON.stringify(effect.metadata),
      createdAt: effect.createdAt
    })

    broadcast({
      type: EventType.EffectRecorded,
      data: {
        id: effect.id,
        runId: effect.runId,
        kind: effect.kind,
        tool: effect.tool,
        target: effect.target,
        status: effect.status
      }
    })

    return effect
  }

  async recordFileWrite(opts: {
    runId: string
    tool: string
    filePath: string
    newContent: string
  }): Promise<Effect> {
    const newHash = hashContent(opts.newContent)
    try {
      const existing = await readFile(opts.filePath, "utf-8")
      const existingHash = hashContent(existing)
      if (existingHash === newHash) {
        return this.recordEffect({
          runId: opts.runId,
          kind: EffectKind.Modify,
          tool: opts.tool,
          target: opts.filePath,
          preHash: existingHash,
          postHash: newHash,
          metadata: { idempotent: true, skipped: true }
        })
      }
    } catch (err: unknown) { console.error("[mia]", err) }

    let kind: EffectKind = EffectKind.Create
    let preHash: string | null = null
    try {
      await stat(opts.filePath)
      kind = EffectKind.Modify
      const existing = await readFile(opts.filePath, "utf-8")
      preHash = hashContent(existing)
    } catch (err: unknown) { console.error("[mia]", err) }

    const effect = this.recordEffect({
      runId: opts.runId,
      kind,
      tool: opts.tool,
      target: opts.filePath,
      preHash,
      postHash: newHash
    })

    await captureSnapshot(opts.runId, effect.id, opts.filePath)
    return effect
  }

  async recordFileDelete(opts: { runId: string; tool: string; filePath: string }): Promise<Effect> {
    let preHash: string | null = null
    try {
      const existing = await readFile(opts.filePath, "utf-8")
      preHash = hashContent(existing)
    } catch {
      return this.recordEffect({
        runId: opts.runId,
        kind: EffectKind.Delete,
        tool: opts.tool,
        target: opts.filePath,
        preHash: null,
        postHash: null,
        metadata: { skipped: true, reason: "file did not exist" }
      })
    }

    const effect = this.recordEffect({
      runId: opts.runId,
      kind: EffectKind.Delete,
      tool: opts.tool,
      target: opts.filePath,
      preHash,
      postHash: null
    })

    await captureSnapshot(opts.runId, effect.id, opts.filePath)
    return effect
  }
}

// ── Default singleton + backward-compatible exports ──────────────

const _default = new EffectTracker()

export function resetEffectSeq(runId: string): void {
  _default.resetEffectSeq(runId)
}

export function recordEffect(opts: {
  runId: string
  kind: EffectKind
  tool: string
  target: string
  preHash?: string | null
  postHash?: string | null
  metadata?: Record<string, unknown>
}): Effect {
  return _default.recordEffect(opts)
}

export async function recordFileWrite(opts: {
  runId: string
  tool: string
  filePath: string
  newContent: string
}): Promise<Effect> {
  return _default.recordFileWrite(opts)
}

export async function recordFileDelete(opts: {
  runId: string
  tool: string
  filePath: string
}): Promise<Effect> {
  return _default.recordFileDelete(opts)
}
