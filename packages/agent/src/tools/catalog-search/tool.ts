import type { Tool } from "../../types.js"
import { buildCatalog, getCatalog } from "../catalog.js"
import {
    handleColumn,
    handleConceptPath,
    handleConcepts,
    handleJoins,
    handleLineage,
    handlePath,
    handleSearch,
    handleStats,
    handleTable,
} from "./handlers.js"

export const searchCatalogTool: Tool = {
  name: "search_catalog",
  description:
    "Search the pre-built schema catalog — your PRIMARY tool for finding tables, columns, and relationships. " +
    "The catalog is a PERSISTENT knowledge graph of the ENTIRE database structure — all schemas, tables, columns, " +
    "FK relationships, and implicit join edges (shared column names). It is pre-computed and cached on disk; searches " +
    "are instant (no SQL queries). ALWAYS use this BEFORE explore_mssql_schema or query_mssql. " +
    "Modes: " +
    "(1) search='revenue' — keyword search across all table and column names. " +
    "(2) table='publish.Revenue' — get full detail for a specific table. " +
    "(3) column='clientId' — find every table that has this column. " +
    "(4) joins='dim.Client' — show ALL join edges (FK + implicit) for a table. " +
    "(5) path=['dim.Client','fact.X'] — find FK join paths between two tables. " +
    "(6) lineage='publish.Revenue' — show full lineage map: all source views, dimension joins, business areas. " +
    "(7) stats=true — catalog summary. " +
    "(8) refresh=true — rebuild from live database and update cache. " +
    "(9) concepts='fact.CommissionAllocation' — show which business concepts this table contributes to (semantic tags from lineage). " +
    "(10) concept_path=['tableA','tableB'] — BFS across FK + implicit join + concept edges; finds paths even without FK relationships.",
  parameters: {
    type: "object",
    properties: {
      search: { type: "string", description: "Keyword search across all table names and column names." },
      table: { type: "string", description: "Get full details for a specific table. Schema-qualified: 'publish.Revenue', 'dim.Client'." },
      column: { type: "string", description: "Find all tables that have a column with this exact name." },
      joins: { type: "string", description: "Show ALL join edges for a table — FK relationships and implicit joins. Schema-qualified: 'dim.Client'." },
      path: {
        type: "array",
        items: { type: "string" },
        description: "Find FK join paths between two tables. Provide exactly two schema-qualified names.",
      },
      stats: { type: "boolean", description: "Return high-level catalog summary: schema count, table/view count, largest tables." },
      lineage: {
        type: "string",
        description: "Show the full lineage map for a critical view. Schema-qualified: 'publish.Revenue'.",
      },
      concept_path: {
        type: "array",
        items: { type: "string" },
        description: "Find concept-aware paths between two tables (FK + implicit + concept edges). Provide exactly two schema-qualified names.",
      },
      concepts: {
        type: "string",
        description: "Show which business concepts a table contributes to, derived from lineage maps.",
      },
      refresh: { type: "boolean", description: "Rebuild the catalog from the live database and update the disk cache." },
      connection: { type: "string", description: "Named database connection. Omit for default." },
    },
    required: [],
  },

  async execute(args) {
    const connName = args.connection ? String(args.connection).trim() : "default"

    if (args.refresh) {
      try {
        const catalog = await buildCatalog({ connection: connName, forceFresh: true })
        const s = catalog.stats()
        return `Catalog rebuilt from live DB and cached to disk: ${s.schemas} schemas, ${s.tables} tables, ${s.views} views, ${s.columns} columns, ${s.fks} FKs, ${s.implicitEdges} implicit join edges.`
      } catch (err) {
        return `Error rebuilding catalog: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    const catalog = getCatalog(connName)
    if (!catalog) {
      return (
        "Schema catalog not available. The catalog is built at server startup when MSSQL is configured. " +
        "Try search_catalog(refresh=true) to build it now, or check that MSSQL_HOST / MSSQL_DATABASES is set."
      )
    }

    if (args.stats) return handleStats(catalog)
    if (args.lineage) return handleLineage(catalog, String(args.lineage).trim())
    if (args.concepts) return handleConcepts(catalog, String(args.concepts).trim())

    if (args.concept_path) {
      const tables = args.concept_path as string[]
      if (!Array.isArray(tables) || tables.length !== 2) {
        return "Error: 'concept_path' requires exactly two schema-qualified table names."
      }
      const [from, to] = tables.map((t) => String(t).trim())
      return handleConceptPath(catalog, from, to)
    }

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

    if (args.search) return handleSearch(catalog, String(args.search).trim())

    return "Error: Provide at least one parameter: search, table, column, joins, path, lineage, stats, or refresh."
  },
}
