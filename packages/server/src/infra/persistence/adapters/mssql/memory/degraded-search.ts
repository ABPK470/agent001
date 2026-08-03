/**
 * MSSQL has no shipped full-text catalog. This is deliberately a degraded
 * recency + token-filter candidate search, not a substitute BM25 implementation.
 */

import { sql } from "kysely"
import { MemoryTier } from "../../../../../internal/enums/memory.js"
import type { MemoryKeywordSearchOpts, MemorySearchPort } from "../../../../../ports/memory-search.js"
import { rowToEntry } from "../../../memory/row.js"
import { runAllAsync } from "../../../schema/execute-async.js"
import { getPlatformDb } from "../../../schema/kysely.js"

/** Same length floor as shared memory scoring tokenize — keep adapters independent. */
function queryTokens(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/\s+/).filter((t) => t.length > 2))]
}

/** Position-independent token score; it makes no relevance-model claim. */
export function countContentTokenHits(content: string, tokens: readonly string[]): number {
  const folded = content.toLocaleLowerCase()
  return tokens.reduce((hits, token) => hits + Number(folded.includes(token)), 0)
}

async function mssqlDegradedSearchKeyword(query: string, opts: MemoryKeywordSearchOpts) {
  const tokens = queryTokens(query)
  if (tokens.length === 0) return []

  let statement = getPlatformDb().selectFrom("memory_entries as e").selectAll("e")
  if (opts.tier) statement = statement.where("e.tier", "=", opts.tier)
  if (opts.excludeRunId) {
    statement = statement.where((eb) =>
      eb.or([eb("e.run_id", "is", null), eb("e.run_id", "!=", opts.excludeRunId!)]),
    )
  }
  if (opts.tier === MemoryTier.Working && opts.threadId && opts.upn) {
    statement = statement.where(
      "e.run_id",
      "in",
      getPlatformDb()
        .selectFrom("runs")
        .select("id")
        .where("thread_id", "=", opts.threadId)
        .where("upn", "=", opts.upn),
    )
  }
  if (opts.upn !== undefined) {
    statement =
      opts.upn === null
        ? statement.where((eb) => eb.or([eb("e.upn", "is", null), eb("e.shared", "=", 1)]))
        : statement.where((eb) => eb.or([eb("e.upn", "=", opts.upn!), eb("e.shared", "=", 1)]))
  }
  if (opts.createdAfter) statement = statement.where("e.created_at", ">", opts.createdAfter)
  statement = statement
    .where((eb) =>
      eb.or(tokens.map((token) => eb(sql<string>`lower(${sql.ref("e.content")})`, "like", `%${token}%`))),
    )
    .orderBy("e.updated_at", "desc")
    .limit(opts.limit)

  const rows = await runAllAsync<Record<string, unknown>>(statement.compile())
  return rows.map((row, index) => ({
    entry: rowToEntry(row),
    rank: countContentTokenHits(String(row.content ?? ""), tokens) + (rows.length - index) / rows.length,
  }))
}

export function createMssqlDegradedMemorySearch(): MemorySearchPort {
  return { kind: "mssql-degraded", searchKeyword: mssqlDegradedSearchKeyword }
}
