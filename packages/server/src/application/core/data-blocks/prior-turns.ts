/**
 * Prior-turn loader — surfaces the last N completed runs in the same
 * session so the orchestrator can inject them as a first-class
 * `<prior_turns>` system anchor and feed them to the clarification
 * detector.
 *
 * The `runs` table is the authoritative session timeline: every user
 * message in a chat is a separate row sharing the same `session_id`.
 * We bypass the FTS/vector retrieval pipeline here on purpose — for
 * pronoun-only follow-ups ("plot it", "filter that") FTS over the
 * current goal returns nothing useful, but the most recent rows in
 * the same session are exactly what the LLM needs to resolve the
 * reference.
 *
 * Tenant-scoped via `upn` (matching listRunsWithUsageForUser policy)
 * and filtered to top-level user turns (`parent_run_id IS NULL`) so
 * internal delegation chatter does not pollute the anchor.
 */

import { truncateAtBoundary } from "../../../adapters/persistence/memory.js"
import type { DbRun } from "../../../adapters/persistence/sqlite.js"
import { getDb } from "../../../adapters/persistence/sqlite.js"

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
  readonly sessionId: string
  /** Exclude the current run id so the live request never references itself. */
  readonly excludeRunId?: string | null
  /** Tenant scope. Required — every persisted run row has a non-null upn
   *  (anonymous-cookie users are mapped to an auto-provisioned upn in
   *  auth/identity.ts), so a null upn would never return any rows. */
  readonly upn: string
  /** Hard cap on the number of prior turns returned. Default: 3. */
  readonly limit?: number
}

/**
 * Load the most recent completed (or failed) top-level runs that share
 * the given session. Returns newest-first. Answers are truncated.
 *
 * Synchronous because better-sqlite3 is synchronous and the orchestrator
 * is already on the request thread.
 */
export function loadPriorTurns(opts: LoadPriorTurnsOptions): PriorTurn[] {
  const limit = opts.limit ?? 3
  if (!opts.sessionId || !opts.upn || limit <= 0) return []
  // Inclusion: completed + failed terminal states. We deliberately skip
  // cancelled/crashed because their answers are usually absent or noisy.
  // Top-level only: `parent_run_id IS NULL` keeps delegated child runs
  // (which inherit the session id) out of the anchor.
  const rows = getDb()
    .prepare(`
      SELECT id, goal, status, answer, created_at, completed_at, parent_run_id, upn
      FROM runs
      WHERE session_id = @sessionId
        AND upn = @upn
        AND parent_run_id IS NULL
        AND status IN ('completed', 'failed')
        AND (@excludeRunId IS NULL OR id != @excludeRunId)
      ORDER BY COALESCE(completed_at, created_at) DESC
      LIMIT @limit
    `)
    .all({
      sessionId:     opts.sessionId,
      excludeRunId:  opts.excludeRunId ?? null,
      upn:           opts.upn,
      limit,
    }) as Pick<DbRun, "id" | "goal" | "status" | "answer" | "created_at" | "completed_at">[]

  return rows.map((row) => ({
    runId:  row.id,
    goal:   row.goal,
    answer: row.answer == null
      ? null
      : truncateAtBoundary(row.answer, PRIOR_TURN_ANSWER_MAX_CHARS, "\u2026 [truncated]"),
    status: row.status,
    ranAt:  row.completed_at ?? row.created_at,
  }))
}
