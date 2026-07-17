import type sql from "mssql"
import type { AgentHost } from "../../application/shell/runtime.js"
import type { ExecutableTool, Tool, ToolMetadata } from "../../domain/agent-types.js"
import { fingerprintForQname, persistToCache, tryServeFromCache } from "../_tool-cache.js"
import { getPool, resolveToolConnectionArg } from "../mssql/index.js"
import { runObjectInspection } from "./handlers/definition.js"
import { runDependsOn, runSearch } from "./handlers/dependency.js"
import { runIndexUsage, runMissingIndexes, runSlowQueries } from "./handlers/observability.js"
import { runScanDuplicates } from "./handlers/scan-duplicates.js"

/**
 * inspect_definition tool. The body dispatches on the args to one of the
 * mode handlers in `./handlers/`.
 *
 * @module
 */

function buildInspectDefinitionTool(host: AgentHost): Tool {
  return {
    name: "inspect_definition",
    description:
      "Read and analyze T-SQL source code of views, stored procedures, and functions. " +
      "Use this to find performance problems: duplicate/redundant joins, inefficient view layers, " +
      "and unnecessary cross-joins. CRITICAL for diagnosing slow ETL pipelines and wide views. " +
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
      "names_query='SELECT name FROM <metadataTable>' (tool runs the query, scans every returned name) — " +
      "PREFERRED when names live in a table; OR names='<schemaA>.<TableA>,<schemaB>.<TableB>' (CSV, max 5000); " +
      "OR schema='<schema>' (only objects defined IN that schema — DO NOT use this for a list sourced from another table). " +
      "Optional: object_types='VIEW,SQL_STORED_PROCEDURE'.",
    parameters: {
      type: "object",
      properties: {
        object: {
          type: "string",
          description:
            "Get T-SQL source + joint reference analysis for this object. " +
            "Schema-qualified: '<schema>.<Object>'. " +
            "For mirrored objects (when the deployment defines a mirror schema) use 3-part form: '<mirrorSchema>.<schema>.<Object>'. " +
            "Highlights duplicate table references that indicate redundant joins."
        },
        depends_on: {
          type: "string",
          description:
            "Get the immediate dependency list for an object — what tables and views it directly references."
        },
        search: {
          type: "string",
          description: "Find all views/procs/functions whose T-SQL definition contains this pattern."
        },
        slow_queries: {
          type: "boolean",
          description:
            "Return top 15 most expensive queries from SQL Server's query stats cache, sorted by average CPU time."
        },
        missing_indexes: {
          type: "boolean",
          description:
            "Return SQL Server's missing index recommendations sorted by estimated improvement score."
        },
        index_usage: {
          type: "string",
          description: "Show index seek/scan/update counts for a specific table. Schema-qualified."
        },
        scan_duplicates: {
          type: "boolean",
          description:
            "Bulk-scan T-SQL definitions for duplicate FROM/JOIN references and return a count summary. " +
            "Combine with `schema`, `names`, or `object_types` to limit scope. " +
            "Use for counting questions like 'how many of these N datasets have duplicate joins?'"
        },
        schema: {
          type: "string",
          description:
            "Restrict scan_duplicates to objects DEFINED in this single schema. " +
            "WARNING: this filters by where the object lives, NOT by membership in some other list. " +
            "If the user gave you a list sourced from a table, do NOT use schema= — use names= or names_query= instead."
        },
        names: {
          type: "string",
          description:
            "Comma-separated qualified object names to limit scan_duplicates to (max 5000). " +
            "Example: '<schemaA>.<TableA>,<schemaB>.<TableB>'. " +
            "Use names_query= instead when the list is large or comes from a SELECT."
        },
        names_query: {
          type: "string",
          description:
            "A SELECT statement returning a single column of qualified object names ('schema.name' format). " +
            "The tool runs it, then scan_duplicates uses the returned values as the names list. " +
            "Use this when the user references a list-bearing table — pass a query like " +
            "'SELECT name FROM <metadataTable>'. Avoids constructing a multi-thousand-element CSV by hand."
        },
        object_types: {
          type: "string",
          description:
            "Comma-separated sys.objects.type_desc filter for scan_duplicates. " +
            "Default: 'VIEW,SQL_STORED_PROCEDURE,SQL_TABLE_VALUED_FUNCTION,SQL_INLINE_TABLE_VALUED_FUNCTION'."
        },
        connection: {
          type: "string",
          description: "Named database connection to use. Omit for default."
        }
      },
      required: []
    },

    async execute(args) {
      let connName: string
      try {
        connName = resolveToolConnectionArg(host, args)
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`
      }

      // Cache pre-flight for `object=` mode — the T-SQL body of a view / proc
      // changes only on DDL, which the catalog fingerprint captures via
      // column-shape changes. Dynamic modes (slow_queries, missing_indexes,
      // index_usage, scan_duplicates, depends_on, search) are NOT cached:
      // they either depend on live runtime stats or take ad-hoc scope.
      if (args.object && typeof args.object === "string") {
        const qn = args.object.trim()
        const fp = fingerprintForQname(host, qn, connName)
        const cached = tryServeFromCache(host, "inspect_definition", qn, "definition", connName, fp)
        if (cached !== null) return cached
      }

      let p: sql.ConnectionPool
      try {
        const r = await getPool(host, connName)
        p = r.pool
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`
      }

      try {
        if (args.slow_queries) return runSlowQueries(p)
        if (args.missing_indexes) return runMissingIndexes(p)
        if (args.index_usage) return runIndexUsage(p, String(args.index_usage).trim())
        if (args.depends_on) return runDependsOn(p, String(args.depends_on).trim())
        if (args.search) return runSearch(p, String(args.search))
        if (args.scan_duplicates) {
          return runScanDuplicates(p, {
            schema: typeof args.schema === "string" ? args.schema : undefined,
            names: args.names,
            names_query: typeof args.names_query === "string" ? args.names_query : undefined,
            object_types: typeof args.object_types === "string" ? args.object_types : undefined
          })
        }
        if (args.object) {
          const qn = String(args.object).trim()
          const out = await runObjectInspection(p, qn)
          if (typeof out === "string" && !out.startsWith("SQL Error:") && !out.startsWith("Error:")) {
            const fp = fingerprintForQname(host, qn, connName)
            persistToCache(host, "inspect_definition", qn, "definition", connName, out, fp)
          }
          return out
        }

        return "Error: Provide at least one parameter: object, depends_on, search, slow_queries, missing_indexes, index_usage, or scan_duplicates."
      } catch (err) {
        return `SQL Error: ${err instanceof Error ? err.message : String(err)}`
      }
    }
  }
}

export const inspectDefinitionToolMetadata: ToolMetadata = (() => {
  const stub = {} as AgentHost
  const t = buildInspectDefinitionTool(stub)
  return {
    name: t.name,
    description: t.description,
    parameters: t.parameters
  }
})()

export const inspectDefinitionTool = inspectDefinitionToolMetadata

export function createInspectDefinitionTool(host: AgentHost): ExecutableTool {
  return buildInspectDefinitionTool(host)
}
