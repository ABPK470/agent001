/**
 * search_catalog tool — the agent's PRIMARY discovery tool.
 *
 * Searches the pre-built schema catalog (CatalogGraph) for tables,
 * columns, and relationships by keyword.  Returns rich, immediately
 * actionable results — no SQL calls needed.
 *
 * Modes:
 *   search='revenue'           → keyword search across table + column names
 *   table='publish.Revenue'    → full detail for a specific table
 *   column='clientId'          → find all tables with this column (join candidates)
 *   path=['dim.Client','fact.X'] → FK path between two tables
 *   stats=true                 → high-level catalog summary
 *   refresh=true               → rebuild the catalog from the live database
 */

import type { Tool } from "../types.js"
import { buildCatalog, getCatalog, type CatalogFK, type CatalogTable } from "./catalog.js"

// ── Formatters ───────────────────────────────────────────────────

function fmtRow(n: number | null): string {
  if (n == null) return ""
  if (n >= 1e9) return `~${(n / 1e9).toFixed(1)}B rows`
  if (n >= 1e6) return `~${(n / 1e6).toFixed(0)}M rows`
  if (n >= 1e3) return `~${(n / 1e3).toFixed(0)}K rows`
  return `${n} rows`
}

function fmtTable(t: CatalogTable, matchedCols?: string[], catalog?: { getImplicitJoins(key: string, limit?: number): { column: string; dataType: string; tables: string[] }[] }): string {
  const lines: string[] = []
  const rowInfo = fmtRow(t.rowCount)

  // Header: name, type, size
  const colCount = t.columns.length
  const fkOut = t.fkOutgoing.length
  const fkIn = t.fkIncoming.length
  const implicitCount = catalog ? catalog.getImplicitJoins(t.qualifiedName).length : 0
  const connectivity = fkOut + fkIn + implicitCount

  const badges: string[] = [t.type]
  if (rowInfo) badges.push(rowInfo)
  badges.push(`${colCount} cols`)
  if (connectivity > 0) badges.push(`${connectivity} joins`)
  if (fkIn > 5) badges.push(`★ central (${fkIn} tables reference this)`)

  lines.push(`  ${t.qualifiedName} (${badges.join(", ")})`)

  // Column names: PKs first, then all non-PK — show enough to judge the table's content
  const pks = t.columns.filter((c) => c.isPK)
  const nonPk = t.columns.filter((c) => !c.isPK)
  const shown = [...pks, ...nonPk].slice(0, 15)
  const colStr = shown.map((c) => {
    const flags: string[] = []
    if (c.isPK) flags.push("PK")
    return `${c.name}${flags.length ? " (" + flags.join(", ") + ")" : ""}`
  }).join(", ")
  lines.push(`    Columns: ${colStr}${colCount > 15 ? ` (+${colCount - 15} more)` : ""}`)

  // Highlight matched columns if any
  if (matchedCols && matchedCols.length > 0) {
    lines.push(`    Matched: ${matchedCols.join(", ")}`)
  }

  // FK relationships — show what this table connects to
  if (fkOut > 0) {
    const dims = t.fkOutgoing.slice(0, 6).map((fk) => `${fk.toSchema}.${fk.toTable}`)
    const unique = [...new Set(dims)]
    lines.push(`    References: ${unique.join(", ")}${fkOut > 6 ? ` (+${fkOut - 6} more)` : ""}`)
  }
  if (fkIn > 0) {
    lines.push(`    Referenced by: ${fkIn} other tables`)
  }

  return lines.join("\n")
}

function fmtPath(path: CatalogFK[]): string {
  return path.map((fk) =>
    `  ${fk.fromSchema}.${fk.fromTable}.${fk.fromColumn} → ${fk.toSchema}.${fk.toTable}.${fk.toColumn}`,
  ).join("\n")
}

// ── The tool ─────────────────────────────────────────────────────

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
    "(6) stats=true — catalog summary. " +
    "(7) refresh=true — rebuild from live database and update cache.",
  parameters: {
    type: "object",
    properties: {
      search: {
        type: "string",
        description:
          "Keyword search across all table names and column names. " +
          "E.g. 'revenue', 'client profitability', 'pipeline run', 'daily balance'. " +
          "Returns ranked results: tables whose name matches first, then column matches.",
      },
      table: {
        type: "string",
        description:
          "Get full details for a specific table. Schema-qualified: 'publish.Revenue', 'dim.Client'. " +
          "Returns all columns with types, primary keys, FK relationships, and row count.",
      },
      column: {
        type: "string",
        description:
          "Find all tables that have a column with this exact name. " +
          "E.g. 'clientId' finds every table that can be joined on clientId.",
      },
      joins: {
        type: "string",
        description:
          "Show ALL join edges for a table — both FK relationships and implicit joins " +
          "(tables sharing a column name with compatible type). Schema-qualified: 'dim.Client'.",
      },
      path: {
        type: "array",
        items: { type: "string" },
        description:
          "Find FK join paths between two tables. Provide exactly two schema-qualified names. " +
          "E.g. ['dim.Client', 'fact.AfricaFlex']. Returns up to 5 shortest FK paths.",
      },
      stats: {
        type: "boolean",
        description: "Return high-level catalog summary: schema count, table/view count, largest tables.",
      },
      refresh: {
        type: "boolean",
        description: "Rebuild the catalog from the live database and update the disk cache. Use after schema changes or as a weekly/daily maintenance step.",
      },
      connection: {
        type: "string",
        description: "Named database connection. Omit for default.",
      },
    },
    required: [],
  },

  async execute(args) {
    const connName = args.connection ? String(args.connection).trim() : "default"

    // Refresh mode
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

    // Stats mode
    if (args.stats) {
      const s = catalog.stats()
      const lines = [
        `Schema Catalog Summary:`,
        `  Schemas: ${s.schemas} | Tables: ${s.tables} | Views: ${s.views}`,
        `  Columns: ${s.columns} | FK relationships: ${s.fks}`,
        `  Total rows: ~${(s.totalRows / 1e6).toFixed(0)}M`,
        "",
        "Largest tables:",
      ]
      for (const t of s.largestTables) {
        lines.push(`  ${t.name}: ${fmtRow(t.rows)}`)
      }
      return lines.join("\n")
    }

    // Table detail mode
    if (args.table) {
      const t = catalog.getTable(String(args.table).trim())
      if (!t) {
        // Try search as fallback
        const hits = catalog.search(String(args.table).replace(".", " "), 3)
        if (hits.length > 0) {
          return `Table '${args.table}' not found. Did you mean:\n${hits.map((h) => `  ${h.table.qualifiedName} (${h.table.type})`).join("\n")}`
        }
        return `Table '${args.table}' not found in catalog. Use search_catalog(search='keyword') to find it.`
      }
      // Full detail
      const lines = [
        `${t.qualifiedName} (${t.type}${t.rowCount != null ? `, ${fmtRow(t.rowCount)}` : ""})`,
        "",
        "Columns:",
      ]
      for (const c of t.columns) {
        const flags = [c.isPK ? "PK" : "", c.nullable ? "nullable" : "NOT NULL"].filter(Boolean).join(", ")
        lines.push(`  ${c.name} (${c.dataType}${c.maxLength && c.maxLength > 0 ? `(${c.maxLength})` : ""}) [${flags}]`)
      }
      if (t.fkOutgoing.length > 0) {
        lines.push("", "FK Outgoing (this table references):")
        for (const fk of t.fkOutgoing) {
          lines.push(`  ${fk.fromColumn} → ${fk.toSchema}.${fk.toTable}.${fk.toColumn} (${fk.constraint})`)
        }
      }
      if (t.fkIncoming.length > 0) {
        lines.push("", `FK Incoming (${t.fkIncoming.length} tables reference this):`)
        for (const fk of t.fkIncoming.slice(0, 10)) {
          lines.push(`  ${fk.fromSchema}.${fk.fromTable}.${fk.fromColumn} → ${fk.toColumn} (${fk.constraint})`)
        }
        if (t.fkIncoming.length > 10) lines.push(`  ... +${t.fkIncoming.length - 10} more`)
      }
      return lines.join("\n")
    }

    // Joins mode: show all FK + implicit join edges for a table
    if (args.joins) {
      const key = String(args.joins).trim()
      const t = catalog.getTable(key)
      if (!t) {
        const hits = catalog.search(key.replace(".", " "), 3)
        if (hits.length > 0) {
          return `Table '${key}' not found. Did you mean:\n${hits.map((h) => `  ${h.table.qualifiedName}`).join("\n")}`
        }
        return `Table '${key}' not found in catalog.`
      }
      const lines = [`Join edges for ${t.qualifiedName}:`]

      if (t.fkOutgoing.length > 0) {
        lines.push("", "FK OUTGOING (this table references):")
        for (const fk of t.fkOutgoing) {
          lines.push(`  ${fk.fromColumn} → ${fk.toSchema}.${fk.toTable}.${fk.toColumn}`)
        }
      }
      if (t.fkIncoming.length > 0) {
        lines.push("", `FK INCOMING (${t.fkIncoming.length} tables reference this):`)
        for (const fk of t.fkIncoming.slice(0, 15)) {
          lines.push(`  ${fk.fromSchema}.${fk.fromTable}.${fk.fromColumn} → ${fk.toColumn}`)
        }
        if (t.fkIncoming.length > 15) lines.push(`  ... +${t.fkIncoming.length - 15} more`)
      }

      const implicit = catalog.getImplicitJoins(key)
      if (implicit.length > 0) {
        lines.push("", `IMPLICIT JOINS (${implicit.length} shared columns with other tables):`)
        for (const edge of implicit) {
          const others = edge.tables.filter((tk) => tk !== key).slice(0, 8)
          lines.push(`  ${edge.column} (${edge.dataType}) → ${others.join(", ")}${edge.tables.length > 9 ? ` (+${edge.tables.length - 9} more)` : ""}`)
        }
      }

      if (t.fkOutgoing.length === 0 && t.fkIncoming.length === 0 && implicit.length === 0) {
        lines.push("  No join edges found (isolated table).")
      }
      return lines.join("\n")
    }

    // Column search mode
    if (args.column) {
      const colName = String(args.column).trim()
      const matches = catalog.findTablesWithColumn(colName)
      if (matches.length === 0) {
        return `No tables found with column '${colName}'. Try search_catalog(search='${colName}') for broader matching.`
      }
      const lines = [
        `Tables with column '${colName}' (${matches.length} found):`,
        "",
      ]
      for (const { table, column } of matches) {
        lines.push(`  ${table.qualifiedName} (${table.type}${table.rowCount != null ? ", " + fmtRow(table.rowCount) : ""})`)
        lines.push(`    ${column.name} (${column.dataType}${column.isPK ? " PK" : ""})`)
      }
      lines.push("", "These tables can be JOINed on this column.")
      return lines.join("\n")
    }

    // Path finding mode
    if (args.path) {
      const tables = args.path as string[]
      if (!Array.isArray(tables) || tables.length !== 2) {
        return "Error: 'path' requires exactly two schema-qualified table names."
      }
      const [from, to] = tables.map((t) => String(t).trim())
      const paths = catalog.findPath(from, to)
      if (paths.length === 0) {
        return `No FK path found between ${from} and ${to} (max depth 5). Try search_catalog(column='sharedColumn') to find implicit join columns.`
      }
      const lines = [`FK paths from ${from} to ${to}:`]
      for (let i = 0; i < paths.length; i++) {
        lines.push(`\nPath ${i + 1} (${paths[i].length} hop${paths[i].length !== 1 ? "s" : ""}):`)
        lines.push(fmtPath(paths[i]))
      }
      return lines.join("\n")
    }

    // Keyword search mode (default)
    if (args.search) {
      const query = String(args.search).trim()
      const hits = catalog.search(query)
      if (hits.length === 0) {
        return `No matches found for '${query}'. Try different keywords or check spelling.`
      }

      const lines = [
        `Schema Catalog Search: '${query}' — ${hits.length} matches`,
        "",
      ]

      // Group results by schema tier for clarity
      const publishHits = hits.filter((h) => h.table.schema === "publish" || h.table.schema === "persistedView")
      const dataHits = hits.filter((h) => h.table.schema === "fact" || h.table.schema === "dim" || h.table.schema === "ext")
      const otherHits = hits.filter((h) =>
        h.table.schema !== "publish" && h.table.schema !== "persistedView" &&
        h.table.schema !== "fact" && h.table.schema !== "dim" && h.table.schema !== "ext",
      )

      if (publishHits.length > 0) {
        lines.push("★ PUBLISH / PERSISTED VIEWS (start here — curated BI layer):")
        for (const h of publishHits) lines.push(fmtTable(h.table, h.matchedColumns, catalog))
      }
      if (dataHits.length > 0) {
        lines.push("", "FACT / DIM / EXT (base data — use if publish doesn't have what you need):")
        for (const h of dataHits) lines.push(fmtTable(h.table, h.matchedColumns, catalog))
      }
      if (otherHits.length > 0) {
        lines.push("", "OTHER:")
        for (const h of otherHits) lines.push(fmtTable(h.table, h.matchedColumns, catalog))
      }

      // Add guidance
      lines.push(
        "",
        "Results ranked by: name match + schema tier (publish ★) + row volume + column richness + FK centrality + join connectivity.",
        "Pick the highest-ranked table in the best schema tier. If unsure, compare column lists above.",
        "Next step: explore_mssql_schema(table='schema.Table') to see all columns, then SELECT TOP 5.",
      )
      return lines.join("\n")
    }

    return "Error: Provide at least one parameter: search, table, column, joins, path, stats, or refresh."
  },
}
