/**
 * Run Queue — concurrency-limited scheduling for agent runs.
 *
 * Why the queue lives here (orchestrator level) and not in the agent:
 *   - The orchestrator owns the LLM client → it controls rate limits
 *   - The orchestrator owns the workspace → it controls filesystem contention
 *   - Delegate agents share the parent's LLM budget → the queue enforces this
 *   - The queue provides fair scheduling across independent user runs
 *     AND within a single run's delegation tree
 *
 * Design:
 *   - Configurable max concurrent runs (default: 5)
 *   - Priority levels: delegated children run at higher priority than new user runs
 *     (so in-flight work completes before new work starts)
 *   - FIFO within same priority level
 *   - Backpressure: callers get a promise that resolves when their slot opens
 *   - Cancellation-aware: cancelled runs release their slot immediately
 */

import { broadcast } from "./ws.js"

// ── Types ────────────────────────────────────────────────────────

export type RunPriority = "critical" | "high" | "normal" | "low"

const PRIORITY_ORDER: Record<RunPriority, number> = {
  critical: 0, // system recovery
  high: 1,     // delegated children (keep in-flight work moving)
  normal: 2,   // user-initiated runs
  low: 3,      // background/batch
}

export interface QueueEntry {
  runId: string
  priority: RunPriority
  enqueuedAt: number
  /** Resolves when a slot is available. The returned release() must be called when done. */
  resolve: (release: () => void) => void
  reject: (err: Error) => void
  signal?: AbortSignal
}

export interface QueueStats {
  concurrency: number
  active: number
  queued: number
  totalProcessed: number
  totalDropped: number
  entries: Array<{ runId: string; priority: RunPriority; waitingMs: number }>
}

// ── RunQueue ─────────────────────────────────────────────────────

export class RunQueue {
  private readonly maxConcurrent: number
  private active = 0
  private totalProcessed = 0
  private totalDropped = 0
  private readonly waiting: QueueEntry[] = []

  constructor(maxConcurrent?: number) {
    this.maxConcurrent = maxConcurrent ?? (Number(process.env["MAX_CONCURRENT_RUNS"]) || 5)
  }

  /**
   * Request a run slot. Returns a promise that resolves with a release() function
   * when a slot is available. The caller MUST call release() when the run finishes.
   *
   * If the AbortSignal fires while waiting, the promise rejects and the entry
   * is removed from the queue.
   */
  acquire(runId: string, priority: RunPriority = "normal", signal?: AbortSignal): Promise<() => void> {
    // Fast path: slot available immediately
    if (this.active < this.maxConcurrent) {
      this.active++
      this.totalProcessed++
      return Promise.resolve(this.createRelease(runId))
    }

    // Slow path: queue and wait
    return new Promise<() => void>((resolve, reject) => {
      const entry: QueueEntry = {
        runId,
        priority,
        enqueuedAt: Date.now(),
        resolve,
        reject,
        signal,
      }

      // Insert in priority order (stable: same priority → FIFO)
      const insertIdx = this.waiting.findIndex(
        (w) => PRIORITY_ORDER[w.priority] > PRIORITY_ORDER[priority],
      )
      if (insertIdx === -1) {
        this.waiting.push(entry)
      } else {
        this.waiting.splice(insertIdx, 0, entry)
      }

      // Broadcast queue position
      broadcast({
        type: "run.queued",
        data: {
          runId,
          position: this.waiting.indexOf(entry) + 1,
          queueLength: this.waiting.length,
        },
      })

      // If the run is cancelled while waiting, remove from queue
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

  /** Create a release function that frees one slot and promotes the next waiter. */
  private createRelease(_runId: string): () => void {
    let released = false
    return () => {
      if (released) return // idempotent
      released = true
      this.active--

      // Promote next waiting entry
      if (this.waiting.length > 0 && this.active < this.maxConcurrent) {
        const next = this.waiting.shift()!
        this.active++
        this.totalProcessed++
        next.resolve(this.createRelease(next.runId))
      }
    }
  }

  /** Remove a run from the wait queue (e.g., on cancel). Returns true if it was found. */
  remove(runId: string): boolean {
    const idx = this.waiting.findIndex((w) => w.runId === runId)
    if (idx === -1) return false
    const [entry] = this.waiting.splice(idx, 1)
    this.totalDropped++
    entry.reject(new Error("Run removed from queue"))
    return true
  }

  /** Get queue statistics. */
  stats(): QueueStats {
    return {
      concurrency: this.maxConcurrent,
      active: this.active,
      queued: this.waiting.length,
      totalProcessed: this.totalProcessed,
      totalDropped: this.totalDropped,
      entries: this.waiting.map((w) => ({
        runId: w.runId,
        priority: w.priority,
        waitingMs: Date.now() - w.enqueuedAt,
      })),
    }
  }
}
