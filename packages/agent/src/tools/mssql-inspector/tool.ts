import sql from "mssql"
import type { Tool } from "../../types.js"
import { getPool } from "../mssql.js"
import { formatDuplicates, parseTSqlReferences } from "./helpers.js"
import {
    BULK_DEFINITIONS,
    GET_DEFINITION,
    GET_DEPENDENCIES,
    INDEX_USAGE,
    MISSING_INDEXES,
    SEARCH_DEFINITIONS,
    SLOW_QUERIES,
} from "./queries.js"

/**
 * Normalize a qualified object name for use with SQL Server's OBJECT_ID().
 * Handles the special case of persistedView schema where object names contain a dot,
 * e.g. 'persistedView.fact.Revenue' → '[persistedView].[fact.Revenue]'
 * Plain 2-part names pass through unchanged: 'publish.Revenue' → 'publish.Revenue'
 */
function normalizePersistredViewName(name: string): string {
  const parts = name.split(".")
  if (parts.length === 3 && parts[0].toLowerCase() === "persistedview") {
    return `[${parts[0]}].[${parts[1]}.${parts[2]}]`
  }
  return name
}

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
    "(6) index_usage='schema.Table' — show index seek/scan/update stats for a table. " +
    "(7) scan_duplicates=true — bulk scan many objects for duplicate FROM/JOIN refs in a single round-trip. " +
    "Use this to answer counting questions like 'how many of these N datasets/views have duplicate joins?' " +
    "without delegating per-object inspection. Scope (one of these is REQUIRED): " +
    "names_query='SELECT name FROM core.Dataset' (tool runs the query, scans every returned name) — " +
    "PREFERRED when names live in a table; OR names='core.vDataset,publish.Revenue' (CSV, max 5000); " +
    "OR schema='core' (only objects defined IN that schema — DO NOT use this for a list sourced from another table). " +
    "Optional: object_types='VIEW,SQL_STORED_PROCEDURE'.",
  parameters: {
    type: "object",
    properties: {
      object: {
        type: "string",
        description:
          "Get T-SQL source + joint reference analysis for this object. " +
          "Schema-qualified: 'publish.ClientBase', 'core.vDataset'. " +
          "For persistedView objects use 3-part form: 'persistedView.fact.Revenue', 'persistedView.publish.Client'. " +
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
      scan_duplicates: {
        type: "boolean",
        description:
          "Bulk-scan T-SQL definitions for duplicate FROM/JOIN references and return a count summary. " +
          "Combine with `schema`, `names`, or `object_types` to limit scope. " +
          "Use for counting questions like 'how many of these N datasets have duplicate joins?'",
      },
      schema: {
        type: "string",
        description:
          "Restrict scan_duplicates to objects DEFINED in this single schema (e.g. 'core', 'publish'). " +
          "WARNING: this filters by where the object lives, NOT by membership in some other list. " +
          "If the user gave you a list sourced from a table (e.g. core.Dataset.name), do NOT use schema= — use names= or names_query= instead.",
      },
      names: {
        type: "string",
        description:
          "Comma-separated qualified object names to limit scan_duplicates to (max 5000). " +
          "Example: 'core.vDataset,publish.Revenue,publish.Client'. " +
          "Use names_query= instead when the list is large or comes from a SELECT.",
      },
      names_query: {
        type: "string",
        description:
          "A SELECT statement returning a single column of qualified object names ('schema.name' format). " +
          "The tool runs it, then scan_duplicates uses the returned values as the names list. " +
          "Use this when the user references a list-bearing table — e.g. for 'how many datasets in core.Dataset have duplicate joins?', " +
          "pass names_query='SELECT name FROM core.Dataset'. Avoids constructing a 4000-element CSV by hand.",
      },
      object_types: {
        type: "string",
        description:
          "Comma-separated sys.objects.type_desc filter for scan_duplicates. " +
          "Default: 'VIEW,SQL_STORED_PROCEDURE,SQL_TABLE_VALUED_FUNCTION,SQL_INLINE_TABLE_VALUED_FUNCTION'.",
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
        // Normalize persistedView.fact.X → [persistedView].[fact.X] for OBJECT_ID()
        const normalizedName = normalizePersistredViewName(qualName)
        const req = p.request()
        req.input("qualifiedName", sql.NVarChar, normalizedName)
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

      // Mode: scan_duplicates — bulk scan many objects in one round-trip
      if (args.scan_duplicates) {
        const schemaFilter = args.schema ? String(args.schema).trim() : null
        const objectTypes = args.object_types
          ? String(args.object_types)
          : "VIEW,SQL_STORED_PROCEDURE,SQL_TABLE_VALUED_FUNCTION,SQL_INLINE_TABLE_VALUED_FUNCTION"

        // names may arrive as a comma-separated string OR a JSON array
        let nameList: string[] = []
        if (Array.isArray(args.names)) {
          nameList = args.names.map((n) => String(n).trim()).filter(Boolean)
        } else if (typeof args.names === "string" && args.names.trim()) {
          nameList = args.names.split(",").map((n) => n.trim()).filter(Boolean)
        }

        // names_query — let the tool source the names list itself.
        // Avoids forcing the agent to construct a 4000-element CSV by hand.
        if (typeof args.names_query === "string" && args.names_query.trim()) {
          const nq = args.names_query.trim()
          if (!/^\s*select\b/i.test(nq)) {
            return "Error: names_query must be a SELECT statement returning a single column of qualified names."
          }
          if (/[;\s](insert|update|delete|drop|alter|truncate|exec|execute|merge)\b/i.test(nq)) {
            return "Error: names_query must be read-only (SELECT only)."
          }
          try {
            const nqResult = await p.request().query(nq)
            const cols = nqResult.recordset.length > 0 ? Object.keys(nqResult.recordset[0]) : []
            const col = cols[0]
            if (!col) {
              return `names_query returned no rows. Cannot build name list.`
            }
            const fromQuery = nqResult.recordset
              .map((r) => String((r as Record<string, unknown>)[col] ?? "").trim())
              .filter(Boolean)
            nameList = nameList.concat(fromQuery)
          } catch (err) {
            return `Error running names_query: ${err instanceof Error ? err.message : String(err)}`
          }
        }

        // Dedup
        nameList = [...new Set(nameList)]

        if (nameList.length > 5000) {
          return `Error: scan_duplicates accepts at most 5000 names, got ${nameList.length}. ` +
            `Narrow the names_query (e.g. add a WHERE clause) or split into batches.`
        }
        const namesCsv = nameList.length > 0 ? nameList.join(",") : null

        if (!schemaFilter && !namesCsv) {
          return "Error: scan_duplicates needs scope. Provide ONE of: " +
            "names_query='SELECT name FROM core.Dataset' (recommended for list-bearing tables), " +
            "names='schema.A,schema.B,...', " +
            "or schema='core' (only scans objects defined in that schema). " +
            "Scanning every object in the database is not allowed."
        }

        const req = p.request()
        req.input("schemaFilter", sql.NVarChar, schemaFilter)
        req.input("namesCsv", sql.NVarChar, namesCsv)
        req.input("objectTypes", sql.NVarChar, objectTypes)
        const result = await req.query(BULK_DEFINITIONS)

        const rows = result.recordset as Array<{
          schema_name: string
          object_name: string
          object_type: string
          definition: string
        }>

        const requestedCount = namesCsv ? nameList.length : rows.length
        const scanned = rows.length
        const withDupes: Array<{ qname: string; type: string; dupes: Array<[string, number]> }> = []

        for (const r of rows) {
          const refs = parseTSqlReferences(String(r.definition ?? ""))
          const dupes = [...refs.entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1])
          if (dupes.length > 0) {
            withDupes.push({
              qname: `${r.schema_name}.${r.object_name}`,
              type: r.object_type,
              dupes,
            })
          }
        }

        // Names that were requested but had no T-SQL definition (tables, missing, etc.)
        let missingLine = ""
        if (namesCsv) {
          const found = new Set(rows.map((r) => `${r.schema_name}.${r.object_name}`))
          const missing = nameList.filter((n) => !found.has(n))
          if (missing.length > 0) {
            const preview = missing.slice(0, 10).join(", ")
            missingLine =
              `\nNote: ${missing.length} of ${requestedCount} requested names had no T-SQL definition ` +
              `(physical tables, missing objects, or types not in object_types filter). ` +
              `First few: ${preview}${missing.length > 10 ? ", ..." : ""}`
          }
        }

        withDupes.sort((a, b) => b.dupes.length - a.dupes.length)
        const lines = [
          `Scanned ${scanned} object${scanned === 1 ? "" : "s"}` +
            (schemaFilter ? ` in schema '${schemaFilter}'` : "") +
            (namesCsv ? ` from ${requestedCount} requested name${requestedCount === 1 ? "" : "s"}` : "") +
            ".",
          `Objects with duplicate FROM/JOIN references: ${withDupes.length} of ${scanned} (${
            scanned === 0 ? "0" : ((withDupes.length / scanned) * 100).toFixed(1)
          }%).`,
          "",
        ]

        if (withDupes.length === 0) {
          lines.push("No duplicate joins found in any scanned object.")
        } else {
          const top = withDupes.slice(0, 50)
          lines.push(`Top ${top.length} (highest duplicate count first):`)
          for (const d of top) {
            const summary = d.dupes
              .slice(0, 3)
              .map(([n, c]) => `${n}×${c}`)
              .join(", ")
            const more = d.dupes.length > 3 ? `, +${d.dupes.length - 3} more` : ""
            lines.push(`  ${d.qname} (${d.type}) — ${d.dupes.length} duplicate ref${d.dupes.length === 1 ? "" : "s"}: ${summary}${more}`)
          }
          if (withDupes.length > top.length) {
            lines.push(`  ... and ${withDupes.length - top.length} more.`)
          }
          lines.push("", "Tip: inspect_definition(object='schema.Name') on any of the above to read full T-SQL.")
        }
        if (missingLine) lines.push(missingLine)
        return lines.join("\n")
      }

      // Mode: object (default — read definition + duplicate analysis)
      if (args.object) {
        const objName = String(args.object).trim()
        const parts = objName.split(".")
        // Support 3-part names like persistedView.fact.Revenue where:
        //   SQL Server schema = "persistedView", object name = "fact.Revenue"
        // Also support plain 2-part schema.Name
        let schema: string
        let name: string
        if (parts.length === 2) {
          ;[schema, name] = parts
        } else if (parts.length === 3 && parts[0].toLowerCase() === "persistedview") {
          schema = parts[0]
          name = `${parts[1]}.${parts[2]}`
        } else {
          return "Error: provide schema-qualified name, e.g. 'publish.ClientBase' or 'persistedView.fact.Revenue'."
        }

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

      return "Error: Provide at least one parameter: object, depends_on, search, slow_queries, missing_indexes, index_usage, or scan_duplicates."
    } catch (err) {
      return `SQL Error: ${err instanceof Error ? err.message : String(err)}`
    }
  },
}
