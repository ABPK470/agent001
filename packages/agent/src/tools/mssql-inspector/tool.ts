import sql from "mssql"
import type { Tool } from "../../types.js"
import { getPool } from "../mssql.js"
import { formatDuplicates, parseTSqlReferences } from "./helpers.js"
import {
    GET_DEFINITION,
    GET_DEPENDENCIES,
    INDEX_USAGE,
    MISSING_INDEXES,
    SEARCH_DEFINITIONS,
    SLOW_QUERIES,
} from "./queries.js"

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
          "Schema-qualified: 'publish.ClientBase', 'core.vDataset'. " +
          "Highlights duplicate table references that indicate redundant joins.",
      },
      depends_on: {
        type: "string",
        description: "Get the immediate dependency list for an object — what tables and views it directly references.",
      },
      search: {
        type: "string",
        description: "Find all views/procs/functions whose T-SQL definition contains this pattern.",
      },
      slow_queries: {
        type: "boolean",
        description: "Return top 15 most expensive queries from SQL Server's query stats cache, sorted by average CPU time.",
      },
      missing_indexes: {
        type: "boolean",
        description: "Return SQL Server's missing index recommendations sorted by estimated improvement score.",
      },
      index_usage: {
        type: "string",
        description: "Show index seek/scan/update counts for a specific table. Schema-qualified: 'publish.ClientBase'.",
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
        lines.push("", `Use inspect_definition(object='schema.Name') on any of these to read its T-SQL.`)
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
        const refLines = allRefs.map(([refName, count]) =>
          count > 1
            ? `  ⚠ ${refName} (${count}x — DUPLICATE)`
            : `    ${refName}`,
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
