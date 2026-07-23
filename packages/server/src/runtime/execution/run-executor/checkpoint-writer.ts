/**
 * checkpoint-writer.ts — the single write-path for run checkpoints.
 *
 * A checkpoint is a serialized snapshot of the full message history, durable
 * enough to resume the run from. This module owns the checkpoint-write
 * contract for the whole server: every site that needs to persist resume
 * state goes through `writeRunCheckpoint`. There is no other caller of
 * `db.saveCheckpoint` in the execution layer.
 *
 * Granularity contract:
 *   • `onToolResult` calls this AFTER every completed tool call (success or
 *     failure), so resume picks up from the most recent tool result — not
 *     from the last completed iteration. This is what makes resume
 *     tool-call granular: only the single in-flight tool call re-runs.
 *   • `onStep` also runs BEFORE tools execute (see `runTools`) so a first-tool
 *     `require_approval` park still has a durable resume point — historically
 *     that path left `lastMessages` empty and `resumeRun` returned null.
 *   • `onStep` at end-of-iteration is a safety net for guard-abort paths
 *     (circuit breaker / forced abort) that append a system message without
 *     firing `onToolResult`.
 *   • The failure and waiting-for-approval finalizers call this with the
 *     last live messages so a crash/timeout/approval-park is resumable too.
 *
 * Failure model: `writeRunCheckpoint` NEVER throws. A checkpoint is a resume
 * convenience; a persistence hiccup must not crash a live run or break the
 * no-amnesia persister that rides the same `onToolResult` hook. Errors are
 * logged and swallowed.
 *
 * @module
 */

import { EventType, type Message } from "@mia/agent"
import { broadcast } from "../../../../infra/events/broadcaster.js"
import * as db from "../../../../infra/persistence/sqlite.js"

export interface WriteCheckpointInput {
  runId: string
  /** Live message history to snapshot. */
  messages: Message[]
  /** Iteration the snapshot was taken in. */
  iteration: number
  /** Run step counter at snapshot time. */
  stepCounter: number
}

/**
 * Persist a checkpoint snapshot and broadcast `CheckpointSaved`. Never throws.
 *
 * Callers may pass an empty `messages` array to signal "nothing durable yet"
 * (e.g. a failure before any tool call completed); such calls are a no-op so
 * a stale/empty checkpoint is never written over a real one.
 */
export function writeRunCheckpoint(input: WriteCheckpointInput): void {
  if (input.messages.length === 0) return
  try {
    db.saveCheckpoint({
      run_id: input.runId,
      messages: JSON.stringify(input.messages),
      iteration: input.iteration,
      step_counter: input.stepCounter,
      updated_at: new Date().toISOString()
    })
    broadcast({
      type: EventType.CheckpointSaved,
      data: {
        runId: input.runId,
        iteration: input.iteration,
        stepCounter: input.stepCounter
      }
    })
  } catch (err) {
    // A checkpoint is a resume convenience, not a correctness invariant of
    // the live run. Log and continue — the run can still complete, it just
    // won't have a fresh checkpoint to resume from.
    console.warn(
      `[checkpoint] writeRunCheckpoint failed for run ${input.runId}:`,
      err instanceof Error ? err.message : String(err)
    )
  }
}
