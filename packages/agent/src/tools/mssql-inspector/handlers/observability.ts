/**
 * Read-only diagnostic handlers backed by SQL Server DMVs:
 *   slow_queries     — top 15 expensive queries (from sys.dm_exec_query_stats)
 *   missing_indexes  — DMV-suggested indexes by improvement score
 *   index_usage      — per-index seek/scan/update counts for one table
 *
 * @module
 */

import sql from "mssql"
import { INDEX_USAGE, MISSING_INDEXES, SLOW_QUERIES } from "../queries.js"

export async function runSlowQueries(p: sql.ConnectionPool): Promise<string> {
  const result = await p.request().query(SLOW_QUERIES)
  if (!result.recordset.length) {
    return "No query stats available. Stats accumulate while SQL Server runs — try again after some workload."
  }
  const lines = ["Top expensive queries (by avg CPU):\n"]
  for (const r of result.recordset) {
    const text = String(r.query_text ?? "").trim().slice(0, 200).replace(/\s+/g, " ")
    lines.push(
      `  avg_cpu: ${r.avg_cpu_ms}ms | avg_elapsed: ${r.avg_elapsed_ms}ms | ` +
      `avg_reads: ${r.avg_logical_reads} | executions: ${r.execution_count}`,
      `  DB: ${r.database_name}`,
      `  SQL: ${text}`,
      "",
    )
  }
  return lines.join("\n")
}

export async function runMissingIndexes(p: sql.ConnectionPool): Promise<string> {
  const result = await p.request().query(MISSING_INDEXES)
  if (!result.recordset.length) {
    return "No missing index recommendations found. SQL Server has not identified any high-impact missing indexes yet."
  }
  const lines = ["Missing index recommendations (sorted by improvement score):\n"]
  for (const r of result.recordset) {
    lines.push(
      `  Table: ${r.table_name}`,
      `  Equality columns: ${r.equality_columns ?? "(none)"}`,
      `  Inequality columns: ${r.inequality_columns ?? "(none)"}`,
      `  Include columns: ${r.included_columns ?? "(none)"}`,
      `  Estimated benefit: ${r.est_pct_benefit}% | Total hits: ${r.total_hits} | Score: ${r.improvement_score}`,
      "",
    )
  }
  return lines.join("\n")
}

export async function runIndexUsage(p: sql.ConnectionPool, qualName: string): Promise<string> {
  const req = p.request()
  req.input("qualifiedName", sql.NVarChar, qualName)
  const result = await req.query(INDEX_USAGE)
  if (!result.recordset.length) {
    return `No indexes found for ${qualName}. Verify the table name with explore_mssql_schema.`
  }
  const lines = [`Index usage for ${qualName}:\n`]
  for (const r of result.recordset) {
    lines.push(
      `  ${r.index_name} (${r.index_type})`,
      `    Keys: ${r.key_columns ?? "(none)"}`,
      `    Seeks: ${r.user_seeks ?? 0} | Scans: ${r.user_scans ?? 0} | Lookups: ${r.user_lookups ?? 0} | Updates: ${r.user_updates ?? 0}`,
      `    Last seek: ${r.last_user_seek ?? "never"} | Last update: ${r.last_user_update ?? "never"}`,
      "",
    )
  }
  return lines.join("\n")
}
