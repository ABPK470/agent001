/**
 * Run Queue — concurrency-limited scheduling for agent runs with per-UPN fairness.
 */

import { EventType } from "@mia/agent"
import { RunPriority } from "../../internal/enums/queue.js"
import type { QueueStats, RunQueuePort } from "../../ports/queue.js"
import { broadcast } from "../events/broadcaster.js"

export { RunPriority }
export type { QueueStats, RunQueuePort }

const PRIORITY_ORDER: Record<RunPriority, number> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3
}

export interface QueueEntry {
  runId: string
  priority: RunPriority
  upn: string | null
  enqueuedAt: number
  resolve: (release: () => void) => void
  reject: (err: Error) => void
  signal?: AbortSignal
}

export class RunQueue implements RunQueuePort {
  private readonly maxConcurrent: number
  private readonly maxPerUpn: number
  private active = 0
  private readonly activeByUpn = new Map<string, number>()
  private totalProcessed = 0
  private totalDropped = 0
  private readonly waiting: QueueEntry[] = []

  constructor(maxConcurrent?: number, maxPerUpn?: number) {
    this.maxConcurrent = maxConcurrent ?? (Number(process.env["MAX_CONCURRENT_RUNS"]) || 8)
    this.maxPerUpn =
      maxPerUpn ??
      (Number(process.env["MAX_RUNS_PER_UPN"]) || 2)
  }

  acquire(
    runId: string,
    priority: RunPriority = RunPriority.Normal,
    signal?: AbortSignal,
    upn?: string | null
  ): Promise<() => void> {
    const owner = upn?.trim().toLowerCase() || null
    if (this.canStartImmediately(owner)) {
      this.activate(owner)
      this.totalProcessed++
      return Promise.resolve(this.createRelease(runId, owner))
    }

    return new Promise<() => void>((resolve, reject) => {
      const entry: QueueEntry = {
        runId,
        priority,
        upn: owner,
        enqueuedAt: Date.now(),
        resolve,
        reject,
        signal
      }

      const insertIdx = this.waiting.findIndex(
        (w) => PRIORITY_ORDER[w.priority] > PRIORITY_ORDER[priority]
      )
      if (insertIdx === -1) this.waiting.push(entry)
      else this.waiting.splice(insertIdx, 0, entry)

      broadcast({
        type: EventType.RunQueued,
        data: {
          runId,
          position: this.waiting.indexOf(entry) + 1,
          queueLength: this.waiting.length,
          ...(owner ? { actorUpn: owner } : {})
        }
      })

      if (signal) {
        const onAbort = () => {
          const idx = this.waiting.indexOf(entry)
          if (idx !== -1) {
            this.waiting.splice(idx, 1)
            this.totalDropped++
            reject(new Error("Run cancelled while queued"))
          }
        }
        signal.addEventListener("abort", onAbort, { once: true })
      }
    })
  }

  private canStartImmediately(upn: string | null): boolean {
    if (this.active >= this.maxConcurrent) return false
    if (!upn) return true
    return (this.activeByUpn.get(upn) ?? 0) < this.maxPerUpn
  }

  private activate(upn: string | null): void {
    this.active++
    if (upn) this.activeByUpn.set(upn, (this.activeByUpn.get(upn) ?? 0) + 1)
  }

  private deactivate(upn: string | null): void {
    this.active = Math.max(0, this.active - 1)
    if (!upn) return
    const n = (this.activeByUpn.get(upn) ?? 1) - 1
    if (n <= 0) this.activeByUpn.delete(upn)
    else this.activeByUpn.set(upn, n)
  }

  /** Fair pick: highest priority band, then fewest active for that UPN, then oldest wait. */
  private pickNextWaiter(): QueueEntry | null {
    if (this.waiting.length === 0) return null
    let bestIdx = -1
    let best: QueueEntry | null = null
    for (let i = 0; i < this.waiting.length; i++) {
      const w = this.waiting[i]!
      if (!this.canStartImmediately(w.upn)) continue
      if (!best) {
        best = w
        bestIdx = i
        continue
      }
      const priCmp = PRIORITY_ORDER[w.priority] - PRIORITY_ORDER[best.priority]
      if (priCmp < 0) {
        best = w
        bestIdx = i
        continue
      }
      if (priCmp > 0) continue
      const wActive = w.upn ? (this.activeByUpn.get(w.upn) ?? 0) : 0
      const bActive = best.upn ? (this.activeByUpn.get(best.upn) ?? 0) : 0
      if (wActive < bActive || (wActive === bActive && w.enqueuedAt < best.enqueuedAt)) {
        best = w
        bestIdx = i
      }
    }
    if (bestIdx < 0 || !best) return null
    this.waiting.splice(bestIdx, 1)
    return best
  }

  private createRelease(_runId: string, upn: string | null): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      this.deactivate(upn)
      this.promote()
    }
  }

  private promote(): void {
    while (this.active < this.maxConcurrent) {
      const next = this.pickNextWaiter()
      if (!next) break
      this.activate(next.upn)
      this.totalProcessed++
      next.resolve(this.createRelease(next.runId, next.upn))
    }
  }

  remove(runId: string): boolean {
    const idx = this.waiting.findIndex((w) => w.runId === runId)
    if (idx === -1) return false
    const [entry] = this.waiting.splice(idx, 1)
    this.totalDropped++
    entry!.reject(new Error("Run removed from queue"))
    return true
  }

  stats(): QueueStats {
    const byUpn: Record<string, { active: number; waiting: number }> = {}
    for (const [upn, n] of this.activeByUpn) {
      byUpn[upn] = { active: n, waiting: 0 }
    }
    for (const w of this.waiting) {
      if (!w.upn) continue
      const row = byUpn[w.upn] ?? { active: 0, waiting: 0 }
      row.waiting++
      byUpn[w.upn] = row
    }
    return {
      concurrency: this.maxConcurrent,
      maxPerUpn: this.maxPerUpn,
      active: this.active,
      queued: this.waiting.length,
      totalProcessed: this.totalProcessed,
      totalDropped: this.totalDropped,
      byUpn,
      entries: this.waiting.map((w) => ({
        runId: w.runId,
        priority: w.priority,
        upn: w.upn,
        waitingMs: Date.now() - w.enqueuedAt
      }))
    }
  }
}
