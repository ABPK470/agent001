/**
 * Dialect-owned memory keyword search.
 *
 * SQLite: FTS5 MATCH + BM25 rank.
 * MSSQL: explicit degraded candidate fetch (recency + token filter) — never
 * silent LIKE pretending to be FTS. Full-Text Catalog may replace degraded later.
 */

import type { MemoryEntry, MemoryTier } from "../infra/persistence/memory/types.js"

export type MemoryKeywordHit = {
  entry: MemoryEntry
  /** Dialect rank hint — higher is better after normalization in the blender. */
  rank: number
}

export type MemoryKeywordSearchOpts = {
  tier?: MemoryTier
  limit: number
  threadId?: string
  excludeRunId?: string
  upn?: string | null
  /** ISO cutoff for working-tier session window. */
  createdAfter?: string
}

export type MemorySearchPort = {
  readonly kind: "sqlite-fts5" | "mssql-degraded"
  /**
   * Keyword candidates for hybrid blend. Empty query → empty hits
   * (caller may fall back to recent working entries).
   */
  searchKeyword(query: string, opts: MemoryKeywordSearchOpts): Promise<MemoryKeywordHit[]>
}
