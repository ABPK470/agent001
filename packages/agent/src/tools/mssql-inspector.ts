/**
 * MSSQL definition inspector — reads and analyzes T-SQL object definitions.
 *
 * Gives the agent the ability to:
 *   - Read view / stored-proc / function source code
 *   - Detect duplicate table references in JOIN chains (a frequent performance bug)
 *   - Trace dependency trees (what does this view ultimately read?)
 *   - Search for all objects that reference a specific table/column
 *   - Surface missing-index hints and expensive-query stats from DMVs
 *
 * Primary use-case: "Find unnecessary joins causing slow pipeline runs"
 * e.g. publish.client_base joined twice in a single publish view.
 */

import sql from "mssql"
import type { Tool } from "../types.js"
import { getPool } from "./mssql.js"

// ── SQL queries ──────────────────────────────────────────────────

/** Get T-SQL source + object type for a named object. */
const GET_DEFINITION = `
  SELECT
    s.name          AS schema_name,
    o.name          AS object_name,
    o.type_desc     AS object_type,
    sm.definition   AS definition,
    o.create_date,
    o.modify_date
  FROM sys.sql_modules sm
  JOIN sys.objects o  ON sm.object_id = o.object_id
  JOIN sys.schemas s  ON o.schema_id = s.schema_id
  WHERE s.name = @schema AND o.name = @object
`

/** Direct dependencies (one hop) of a named object. */
const GET_DEPENDENCIES = `
  SELECT DISTINCT
    COALESCE(rs.name, d.referenced_schema_name)   AS ref_schema,
    COALESCE(ro.name, d.referenced_entity_name)   AS ref_name,
    COALESCE(ro.type_desc, 'UNKNOWN')             AS ref_type
  FROM sys.sql_expression_dependencies d
  LEFT JOIN sys.objects ro  ON d.referenced_id = ro.object_id
  LEFT JOIN sys.schemas rs  ON ro.schema_id = rs.schema_id
  WHERE d.referencing_id = OBJECT_ID(@qualifiedName)
    AND d.referenced_entity_name IS NOT NULL
  ORDER BY ref_schema, ref_name
`

/** All objects whose definition references a given table/pattern. */
const SEARCH_DEFINITIONS = `
  SELECT
    s.name          AS schema_name,
    o.name          AS object_name,
    o.type_desc     AS object_type,
    o.modify_date
  FROM sys.sql_modules sm
  JOIN sys.objects o  ON sm.object_id = o.object_id
  JOIN sys.schemas s  ON o.schema_id = s.schema_id
  WHERE sm.definition LIKE @pattern
  ORDER BY s.name, o.type_desc, o.name
`

/** Missing index recommendations from SQL Server DMVs. */
const MISSING_INDEXES = `
  SELECT TOP 20
    mid.statement                                                          AS table_name,
    mid.equality_columns,
    mid.inequality_columns,
    mid.included_columns,
    migs.unique_compiles,
    migs.user_seeks + migs.user_scans                                      AS total_hits,
    CAST(migs.avg_total_user_cost * migs.avg_user_impact
         * (migs.user_seeks + migs.user_scans) AS INT)                    AS improvement_score,
    CAST(migs.avg_user_impact AS INT)                                      AS est_pct_benefit
  FROM sys.dm_db_missing_index_details mid
  JOIN sys.dm_db_missing_index_groups mig
    ON mid.index_handle = mig.index_handle
  JOIN sys.dm_db_missing_index_group_stats migs
    ON mig.index_group_handle = migs.group_handle
  ORDER BY improvement_score DESC
`

/** Top expensive queries by avg CPU from query stats cache. */
const SLOW_QUERIES = `
  SELECT TOP 15
    qs.execution_count,
    CAST(qs.total_worker_time   / qs.execution_count / 1000.0 AS INT) AS avg_cpu_ms,
    CAST(qs.total_elapsed_time  / qs.execution_count / 1000.0 AS INT) AS avg_elapsed_ms,
    CAST(qs.total_logical_reads / qs.execution_count AS INT)          AS avg_logical_reads,
    qs.total_logical_reads                                             AS total_logical_reads,
    SUBSTRING(
      qt.text,
      (qs.statement_start_offset / 2) + 1,
      (
        (CASE qs.statement_end_offset WHEN -1 THEN DATALENGTH(qt.text)
         ELSE qs.statement_end_offset END - qs.statement_start_offset) / 2
      ) + 1
    ) AS query_text,
    DB_NAME(qt.dbid) AS database_name
  FROM sys.dm_exec_query_stats qs
  CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) qt
  WHERE qt.text NOT LIKE '%dm_exec_query_stats%'
  ORDER BY avg_cpu_ms DESC
`

/** Index usage stats for a specific table. */
const INDEX_USAGE = `
  SELECT
    i.name                                                    AS index_name,
    i.type_desc                                               AS index_type,
    ius.user_seeks,
    ius.user_scans,
    ius.user_lookups,
    ius.user_updates,
    ius.last_user_seek,
    ius.last_user_scan,
    ius.last_user_update,
    STUFF(
      (SELECT ', ' + c.name
       FROM sys.index_columns ic2
       JOIN sys.columns c ON ic2.object_id = c.object_id AND ic2.column_id = c.column_id
       WHERE ic2.object_id = i.object_id AND ic2.index_id = i.index_id
         AND ic2.is_included_column = 0
       ORDER BY ic2.key_ordinal
       FOR XML PATH('')), 1, 2, ''
    ) AS key_columns
  FROM sys.indexes i
  LEFT JOIN sys.dm_db_index_usage_stats ius
    ON i.object_id = ius.object_id AND i.index_id = ius.index_id
    AND ius.database_id = DB_ID()
  WHERE i.object_id = OBJECT_ID(@qualifiedName)
    AND i.type > 0
  ORDER BY COALESCE(ius.user_seeks + ius.user_scans, 0) DESC
`

// ── Duplicate join detection ─────────────────────────────────────

/**
 * Parse a T-SQL definition and find table/view references in FROM/JOIN clauses.
 * Returns a map of qualified-name → occurrence count.
 */
function parseTSqlReferences(definition: string): Map<string, number> {
  // Normalize: collapse whitespace, strip comments
  const cleaned = definition
    .replace(/--[^\n]*/g, " ")                          // line comments
    .replace(/\/\*[\s\S]*?\*\//g, " ")                  // block comments
    .replace(/\s+/g, " ")
    .toUpperCase()

  const counts = new Map<string, number>()

  // Match FROM / JOIN patterns: FROM schema.table or JOIN schema.table [AS alias]
  // Also handles [schema].[table] bracket quoting and bare table names
  const ref = /(?:FROM|JOIN)\s+(?:\[?(\w+)\]?\.\[?(\w+)\]?|\[?(\w+)\]?)(?:\s+(?:AS\s+)?\[?\w+\]?)?/g
  let m: RegExpExecArray | null
  while ((m = ref.exec(cleaned)) !== null) {
    let key: string
    if (m[1] && m[2]) {
      key = `${m[1]}.${m[2]}`
    } else if (m[3]) {
      // Bare name — no schema prefix
      key = m[3]
    } else continue

    // Skip SQL Server system aliases that look like table refs
    if (/^(INNER|LEFT|RIGHT|FULL|OUTER|CROSS|LATERAL)$/.test(key)) continue

    counts.set(key, (counts.get(key) ?? 0) + 1)
  }

  return counts
}

function formatDuplicates(counts: Map<string, number>): string {
  const dupes = [...counts.entries()].filter(([, n]) => n > 1)
  if (dupes.length === 0) return "No duplicate table references found."
  return (
    `DUPLICATE JOIN REFERENCES DETECTED (${dupes.length}):\n` +
    dupes.map(([name, n]) => `  ${name} — referenced ${n} times`).join("\n") +
    "\n\nThese are likely candidates for join redundancy. " +
    "Removing duplicate joins can significantly reduce execution time on large tables."
  )
}

// ── The tool ─────────────────────────────────────────────────────

export const inspectDefinitionTool: Tool = {
  name: "inspect_definition",
  description:
    "Read and analyze T-SQL source code of views, stored procedures, and functions. " +
    "Use this to find performance problems: duplicate/redundant joins, inefficient view layers, " +
    "and unnecessary cross-joins. CRITICAL for diagnosing slow ETL pipelines and publish views. " +
    "Modes: " +
    "(1) object='schema.Name' — read T-SQL source, list all table references, flag duplicate joins. " +
    "(2) depends_on='schema.Name' — full dependency tree (what tables/views does it ultimately read?). " +
    "(3) search='pattern' — find all views/procs whose definition mentions a table or column name. " +
    "(4) slow_queries=true — top expensive queries from the query stats cache (avg CPU/reads). " +
    "(5) missing_indexes=true — SQL Server's missing index recommendations with impact score. " +
    "(6) index_usage='schema.Table' — show index seek/scan/update stats for a table.",
  parameters: {
    type: "object",
    properties: {
      object: {
        type: "string",
        description:
          "Get T-SQL source + joint reference analysis for this object. " +
          "Schema-qualified: 'publish.ClientBase', 'core.vDataset', 'dbo.GetClientHierarchy'. " +
          "Highlights duplicate table references that indicate redundant joins.",
      },
      depends_on: {
        type: "string",
        description:
          "Get the immediate dependency list for an object — what tables and views it directly references. " +
          "Use this to understand layers: does a publish view reference a persistedView which references a fact table?",
      },
      search: {
        type: "string",
        description:
          "Find all views/procs/functions whose T-SQL definition contains this pattern. " +
          "E.g. search='client_base' finds every view that joins client_base (useful for impact analysis). " +
          "E.g. search='UnoTranspose' finds every object that touches the 2.4B-row table.",
      },
      slow_queries: {
        type: "boolean",
        description:
          "Return top 15 most expensive queries from SQL Server's query stats cache, " +
          "sorted by average CPU time. Reveals which queries are causing the most load.",
      },
      missing_indexes: {
        type: "boolean",
        description:
          "Return SQL Server's missing index recommendations sorted by estimated improvement score. " +
          "Each row shows what index to add and how much improvement is expected.",
      },
      index_usage: {
        type: "string",
        description:
          "Show index seek/scan/update counts for a specific table. " +
          "Identifies unused indexes (overhead for no gain) or missing ones. " +
          "Schema-qualified: 'publish.ClientBase', 'dim.Client'.",
      },
      connection: {
        type: "string",
        description: "Named database connection to use. Omit for default.",
      },
    },
    required: [],
  },

  async execute(args) {
    const connName = args.connection ? String(args.connection).trim() : undefined

    let p: sql.ConnectionPool
    try {
      const r = await getPool(connName)
      p = r.pool
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`
    }

    try {
      // Mode: slow_queries
      if (args.slow_queries) {
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

      // Mode: missing_indexes
      if (args.missing_indexes) {
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

      // Mode: index_usage
      if (args.index_usage) {
        const qualName = String(args.index_usage).trim()
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

      // Mode: depends_on
      if (args.depends_on) {
        const qualName = String(args.depends_on).trim()
        const req = p.request()
        req.input("qualifiedName", sql.NVarChar, qualName)
        const result = await req.query(GET_DEPENDENCIES)

        if (!result.recordset.length) {
          return `No dependencies found for ${qualName}. It may have no static references, or use dynamic SQL.`
        }

        const tables = result.recordset.filter((r: Record<string, string>) =>
          r.ref_type === "USER_TABLE" || r.ref_type === "SYSTEM_TABLE",
        )
        const views = result.recordset.filter((r: Record<string, string>) => r.ref_type === "VIEW")
        const procs = result.recordset.filter((r: Record<string, string>) =>
          r.ref_type?.includes("PROCEDURE") || r.ref_type?.includes("FUNCTION"),
        )

        const lines = [`Dependencies of ${qualName} (${result.recordset.length} direct references):\n`]
        if (views.length > 0) {
          lines.push(`  Views (${views.length}):`)
          for (const v of views) lines.push(`    ${v.ref_schema}.${v.ref_name}`)
        }
        if (tables.length > 0) {
          lines.push(`  Base tables (${tables.length}):`)
          for (const t of tables) lines.push(`    ${t.ref_schema}.${t.ref_name}`)
        }
        if (procs.length > 0) {
          lines.push(`  Procs/Functions (${procs.length}):`)
          for (const p2 of procs) lines.push(`    ${p2.ref_schema}.${p2.ref_name}`)
        }
        lines.push(
          "",
          `Tip: Call inspect_definition(object='${qualName}') to read the full T-SQL and spot duplicate joins.`,
          `Tip: Call inspect_definition(depends_on='schema.ViewName') on any listed view for deeper traversal.`,
        )
        return lines.join("\n")
      }

      // Mode: search
      if (args.search) {
        const pattern = `%${String(args.search)}%`
        const req = p.request()
        req.input("pattern", sql.NVarChar, pattern)
        const result = await req.query(SEARCH_DEFINITIONS)

        if (!result.recordset.length) {
          return `No objects found whose definition references '${String(args.search)}'.`
        }

        const lines = [
          `Objects referencing '${String(args.search)}' in their definition (${result.recordset.length} found):\n`,
        ]
        const byType = new Map<string, Array<{ schema: string; name: string; modified: string }>>()
        for (const r of result.recordset) {
          const type = String(r.object_type)
          if (!byType.has(type)) byType.set(type, [])
          byType.get(type)!.push({ schema: r.schema_name, name: r.object_name, modified: String(r.modify_date ?? "") })
        }
        for (const [type, items] of byType) {
          lines.push(`  ${type} (${items.length}):`)
          for (const item of items) lines.push(`    ${item.schema}.${item.name}`)
        }
        lines.push(
          "",
          `Use inspect_definition(object='schema.Name') on any of these to read its T-SQL.`,
        )
        return lines.join("\n")
      }

      // Mode: object (default — read definition + duplicate analysis)
      if (args.object) {
        const objName = String(args.object).trim()
        const parts = objName.split(".")
        if (parts.length !== 2) {
          return "Error: provide schema-qualified name, e.g. 'publish.ClientBase'."
        }
        const [schema, name] = parts

        const req = p.request()
        req.input("schema", sql.NVarChar, schema)
        req.input("object", sql.NVarChar, name)
        const result = await req.query(GET_DEFINITION)

        if (!result.recordset.length) {
          return (
            `No definition found for ${objName}. ` +
            `Check the object exists with explore_mssql_schema(search='${name}'). ` +
            `Tables don't have T-SQL definitions — use explore_mssql_schema(table='${objName}') instead.`
          )
        }

        const row = result.recordset[0]
        const definition = String(row.definition ?? "")

        // Duplicate join analysis
        const refs = parseTSqlReferences(definition)
        const allRefs = [...refs.entries()].sort((a, b) => b[1] - a[1])
        const dupeAnalysis = formatDuplicates(refs)

        // Summary of all table refs with counts
        const refLines = allRefs.map(([name, count]) =>
          count > 1
            ? `  ⚠ ${name} (${count}x — DUPLICATE)`
            : `    ${name}`,
        )

        // Trim definition for output (cap at 8000 chars)
        const defTrimmed = definition.slice(0, 8000)
        const defNote = definition.length > 8000
          ? `\n(Definition truncated — ${definition.length - 8000} chars omitted. Full source is in the database.)`
          : ""

        return [
          `Definition: ${schema}.${name} (${row.object_type})`,
          `Created: ${row.create_date} | Modified: ${row.modify_date}`,
          "",
          "TABLE/VIEW REFERENCES IN FROM/JOIN CLAUSES:",
          ...refLines,
          "",
          dupeAnalysis,
          "",
          "T-SQL SOURCE:",
          "─".repeat(60),
          defTrimmed + defNote,
        ].join("\n")
      }

      return "Error: Provide at least one parameter: object, depends_on, search, slow_queries, missing_indexes, or index_usage."
    } catch (err) {
      return `SQL Error: ${err instanceof Error ? err.message : String(err)}`
    }
  },
}
