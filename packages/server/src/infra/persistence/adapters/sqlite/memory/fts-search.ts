/**
 * SQLite-only FTS5 implementation. `getDb()` is intentionally confined here:
 * `memory_entries_fts` is a SQLite virtual table and has no MSSQL equivalent.
 */

import { MemoryTier } from "../../../../../internal/enums/memory.js"
import type { MemoryKeywordSearchOpts, MemorySearchPort } from "../../../../../ports/memory-search.js"
import { rowToEntry } from "../../../memory/row.js"
import { getDb } from "../connection.js"
import { sanitizeFtsQuery, WORKING_SESSION_WINDOW_H } from "./scoring.js"

async function sqliteFtsSearchKeyword(query: string, opts: MemoryKeywordSearchOpts) {
  const ftsQuery = sanitizeFtsQuery(query)
  if (!ftsQuery) return []

  let statement = `
    SELECT e.*, memory_entries_fts.rank AS fts_rank
    FROM memory_entries e
    JOIN memory_entries_fts ON e.rowid = memory_entries_fts.rowid
    WHERE memory_entries_fts MATCH ?
  `
  const params: unknown[] = [ftsQuery]
  if (opts.tier) {
    statement += " AND e.tier = ?"
    params.push(opts.tier)
  }
  if (opts.excludeRunId) {
    statement += " AND (e.run_id IS NULL OR e.run_id != ?)"
    params.push(opts.excludeRunId)
  }
  if (opts.tier === MemoryTier.Working && opts.threadId && opts.upn) {
    statement += " AND e.run_id IN (SELECT id FROM runs WHERE thread_id = ? AND upn = ?)"
    params.push(opts.threadId, opts.upn)
  }
  if (opts.upn !== undefined) {
    if (opts.upn === null) statement += " AND (e.upn IS NULL OR e.shared = 1)"
    else {
      statement += " AND (e.upn = ? OR e.shared = 1)"
      params.push(opts.upn)
    }
  }
  if (opts.tier === MemoryTier.Working) {
    statement += " AND e.created_at > ?"
    params.push(
      opts.createdAfter ??
        new Date(Date.now() - WORKING_SESSION_WINDOW_H * 3_600_000).toISOString(),
    )
  }
  statement += " ORDER BY fts_rank LIMIT ?"
  params.push(opts.limit)

  const rows = getDb()
    .prepare(statement)
    .all(...params) as Array<Record<string, unknown> & { fts_rank: number }>
  return rows.map((row) => ({
    entry: rowToEntry(row),
    rank: Math.abs(row.fts_rank),
  }))
}

export function createSqliteMemorySearch(): MemorySearchPort {
  return { kind: "sqlite-fts5", searchKeyword: sqliteFtsSearchKeyword }
}
