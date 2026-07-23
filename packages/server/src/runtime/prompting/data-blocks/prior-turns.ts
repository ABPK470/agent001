/**
 * Prior-turn loader — surfaces the last N completed runs in the same
 * thread so the orchestrator can inject them as a first-class
 * `<prior_turns>` system anchor and feed them to the clarification
 * detector.
 *
 * Continuity is scoped exclusively by `thread_id` (see continuity.ts).
 * We bypass the FTS/vector retrieval pipeline here on purpose — for
 * pronoun-only follow-ups ("plot it", "filter that") FTS over the
 * current goal returns nothing useful, but the most recent rows in
 * the same thread are exactly what the LLM needs to resolve the
 * reference.
 */

import { truncateAtBoundary } from "../../../infra/persistence/memory.js"
import type { DbRun } from "../../../infra/persistence/sqlite.js"
import { getDb } from "../../../infra/persistence/sqlite.js"

/** Maximum chars retained per prior-turn answer. Keeps the anchor inside
 *  the prompt budget while preserving small result tables and the
 *  recap a follow-up needs to reference. */
export const PRIOR_TURN_ANSWER_MAX_CHARS = 1200

/** One prior turn, ready to be rendered into the `<prior_turns>` block. */
export interface PriorTurn {
  readonly runId: string
  readonly goal: string
  /** Truncated to PRIOR_TURN_ANSWER_MAX_CHARS at a line/sentence boundary. */
  readonly answer: string | null
  readonly status: string
  /** ISO timestamp when the run completed (or `created_at` if still null). */
  readonly ranAt: string
}

export interface LoadPriorTurnsOptions {
  readonly threadId: string
  /** Exclude the current run id so the live request never references itself. */
  readonly excludeRunId?: string | null
  /** Tenant scope. Required — every persisted run row has a non-null upn. */
  readonly upn: string
  /** Hard cap on the number of prior turns returned. Default: 3. */
  readonly limit?: number
}

/**
 * Load the most recent completed (or failed) top-level runs in a thread.
 * Returns newest-first. Answers are truncated.
 */
export function loadPriorTurns(opts: LoadPriorTurnsOptions): PriorTurn[] {
  const limit = opts.limit ?? 3
  if (!opts.upn || !opts.threadId || limit <= 0) return []

  const rows = getDb()
    .prepare(
      `
      SELECT id, goal, status, answer, created_at, completed_at, parent_run_id, upn
      FROM runs
      WHERE thread_id = @threadId
        AND upn = @upn
        AND parent_run_id IS NULL
        AND status IN ('completed', 'failed')
        AND (@excludeRunId IS NULL OR id != @excludeRunId)
      ORDER BY COALESCE(completed_at, created_at) DESC
      LIMIT @limit
    `
    )
    .all({
      threadId: opts.threadId,
      excludeRunId: opts.excludeRunId ?? null,
      upn: opts.upn,
      limit
    }) as Pick<DbRun, "id" | "goal" | "status" | "answer" | "created_at" | "completed_at">[]

  return rows.map((row) => ({
    runId: row.id,
    goal: row.goal,
    answer:
      row.answer == null
        ? null
        : truncateAtBoundary(row.answer, PRIOR_TURN_ANSWER_MAX_CHARS, "\u2026 [truncated]"),
    status: row.status,
    ranAt: row.completed_at ?? row.created_at
  }))
}
