/**
 * Postgres native memory keyword search via tsvector / plainto_tsquery('simple').
 * Regconfig `simple` avoids English stemming so code/ids match like sqlite FTS5.
 */

import { sql } from "kysely"
import { MemoryTier } from "../../../../../internal/enums/memory.js"
import type { MemoryKeywordSearchOpts, MemorySearchPort } from "../../../../../ports/memory-search.js"
import { rowToEntry } from "../../../memory/row.js"
import { runAllAsync } from "../../../schema/execute-async.js"
import { getPlatformDb } from "../../../schema/kysely.js"

function queryTokens(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/\s+/).filter((t) => t.length > 1))]
}

async function postgresTsvectorSearchKeyword(query: string, opts: MemoryKeywordSearchOpts) {
  const tokens = queryTokens(query)
  if (tokens.length === 0) return []

  const plain = tokens.join(" ")
  let statement = getPlatformDb()
    .selectFrom("memory_entries as e")
    .selectAll("e")
    .select(sql<number>`ts_rank(e.search_vector, plainto_tsquery('simple', ${plain}))`.as("ts_rank"))
    .where(sql`e.search_vector @@ plainto_tsquery('simple', ${plain})`)

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

  statement = statement.orderBy(sql`ts_rank(e.search_vector, plainto_tsquery('simple', ${plain}))`, "desc").limit(opts.limit)

  const rows = await runAllAsync<Record<string, unknown> & { ts_rank: number }>(statement.compile())
  return rows.map((row) => ({
    entry: rowToEntry(row),
    rank: Number(row.ts_rank ?? 0),
  }))
}

export function createPostgresTsvectorMemorySearch(): MemorySearchPort {
  return { kind: "postgres-tsvector", searchKeyword: postgresTsvectorSearchKeyword }
}
