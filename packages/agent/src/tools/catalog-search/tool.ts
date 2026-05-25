import type { AgentHost } from "../../host/index.js"
import type { Tool } from "../../types.js"
import { buildCatalog, getCatalog, getCatalogConnectionNames } from "../catalog/index.js"
import {
    handleColumn,
    handleJoins,
    handlePath,
    handleSearch,
    handleStats,
    handleSys,
    handleTable,
} from "./handlers.js"

function buildSearchCatalogTool(host: AgentHost): Tool { return {
  name: "search_catalog",
  description:
    "Search the pre-built schema catalog — your PRIMARY tool for finding tables, columns, and relationships. " +
    "The catalog is a PERSISTENT knowledge graph of the ENTIRE database structure — all schemas, tables, columns, " +
    "FK relationships, and implicit join edges (shared column names). It is pre-computed and cached on disk; searches " +
    "are instant (no SQL queries). ALWAYS use this BEFORE explore_mssql_schema or query_mssql. " +
    "Modes: " +
    "(1) search='<keyword>' — keyword search across all table and column names (also searches sys.* DMV catalog). " +
    "(2) table='<schema>.<Table>' — get full detail for a specific table. " +
    "(3) column='<columnName>' — find every table that has this column. " +
    "(4) joins='<schema>.<Table>' — show ALL join edges (FK + implicit) for a table. " +
    "(5) path=['<schemaA>.<TableA>','<schemaB>.<TableB>'] — find FK join paths between two tables. " +
    "(6) stats=true — catalog summary. " +
    "(7) refresh=true — rebuild from live database and update cache. " +
    "(8) sys='<sysKeyword>' — search the SQL Server system catalog (sys.* DMVs, catalog views, TVFs). " +
    "Use sys= for: columnstore internals, index fragmentation, query performance, wait statistics, locking, " +
    "memory, partitioning, HA/Always On, server config. sys= returns the right DMV + example query — " +
    "then call query_mssql to run it.",
  parameters: {
    type: "object",
    properties: {
      search: { type: "string", description: "Keyword search across all table names and column names." },
      schema: { type: "string", description: "Filter search results to a specific schema. Use with search= to scope results." },
      table: { type: "string", description: "Get full details for a specific table. Schema-qualified: '<schema>.<Table>'." },
      column: { type: "string", description: "Find all tables that have a column with this exact name." },
      joins: { type: "string", description: "Show ALL join edges for a table — FK relationships and implicit joins. Schema-qualified." },
      path: {
        type: "array",
        items: { type: "string" },
        description: "Find FK join paths between two tables. Provide exactly two schema-qualified names.",
      },
      stats: { type: "boolean", description: "Return high-level catalog summary: schema count, table/view count, largest tables." },
      refresh: { type: "boolean", description: "Rebuild the catalog from the live database and update the disk cache." },
      connection: { type: "string", description: "Named database connection. Omit for default." },
    },
    required: [],
  },

  async execute(args) {
    const connName = args.connection ? String(args.connection).trim() : "default"

    if (args.refresh) {
      try {
        const catalog = await buildCatalog(host, { connection: connName, forceFresh: true })
        const s = catalog.stats()
        return `Catalog rebuilt from live DB and cached to disk: ${s.schemas} schemas, ${s.tables} tables, ${s.views} views, ${s.columns} columns, ${s.fks} FKs, ${s.implicitEdges} implicit join edges.`
      } catch (err) {
        return `Error rebuilding catalog: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    const catalog = getCatalog(host, connName)
    if (!catalog) {
      const available = getCatalogConnectionNames(host)
      const hint = available.length > 0
        ? `Available connections: ${available.join(", ")}. Pass connection='${available[0]}' to target that database, or omit for auto-select.`
        : "No catalogs loaded. The catalog is built at server startup when MSSQL is configured. " +
          "Try search_catalog(refresh=true) to build it now, or check that MSSQL_HOST / MSSQL_DATABASES is set."
      return `Schema catalog not available for connection '${connName}'. ${hint}`
    }

    if (args.stats) return handleStats(catalog)
    if (args.sys) return handleSys(catalog, String(args.sys).trim())

    if (args.table) return handleTable(catalog, String(args.table).trim())
    if (args.joins) return handleJoins(catalog, String(args.joins).trim())
    if (args.column) return handleColumn(catalog, String(args.column).trim())

    if (args.path) {
      const tables = args.path as string[]
      if (!Array.isArray(tables) || tables.length !== 2) {
        return "Error: 'path' requires exactly two schema-qualified table names."
      }
      const [from, to] = tables.map((t) => String(t).trim())
      return handlePath(catalog, from, to)
    }

    if (args.search) {
      const schemaFilter = args.schema ? String(args.schema).trim() : undefined
      return handleSearch(catalog, String(args.search).trim(), schemaFilter, host.tableVerdicts)
    }

    return "Error: Provide at least one parameter: search, table, column, joins, path, stats, refresh, or sys."
  },
} }

export const searchCatalogTool: Tool = (() => {
  const stub = {} as AgentHost
  const t = buildSearchCatalogTool(stub)
  return {
    name: t.name,
    description: t.description,
    parameters: t.parameters,
    async execute(_args) {
      throw new Error("searchCatalogTool must be built via createSearchCatalogTool(host)")
    },
  }
})()

// ── Host-bound factory (Phase 4 item 7 — API surface only) ───────

export function createSearchCatalogTool(host: AgentHost): Tool {
  return buildSearchCatalogTool(host)
}
