/**
 * MSSQL relationship discovery tool — deep FK graph traversal,
 * implicit join detection, and path-finding between tables.
 *
 * Gives the agent a relationship-first understanding of the database.
 * Instead of exploring one table at a time, this tool maps the full
 * FK graph and finds join paths between any two tables.
 */

import sql from "mssql"
import type { AgentHost } from "../../application/shell/runtime.js"
import type { ExecutableTool, Tool, ToolMetadata } from "../../domain/agent-types.js"
import {
  fingerprintForCatalogBuild,
  fingerprintForQname,
  persistToCache,
  tryServeFromCache
} from "../_tool-cache.js"
import { getPool } from "../mssql/index.js"
import {
  bfs,
  buildAdjacency,
  FK_ALL,
  FK_FOR_SCHEMA,
  FK_FOR_TABLE,
  formatPath,
  IMPLICIT_JOINS,
  type FkEdge
} from "./queries.js"

// ── The tool ────────────────────────────────────
function buildDiscoverRelationshipsTool(host: AgentHost): Tool {
  return {
    name: "discover_relationships",
    description:
      "Discover database relationships — foreign key graphs, join paths between tables, and implicit column-name matches. " +
      "Use this to understand HOW tables connect before writing multi-table queries. " +
      "Modes: (1) table='schema.Table' — show all FK relationships to/from a table. " +
      "(2) between=['schema.TableA','schema.TableB'] — find join paths connecting two tables via FK chains. " +
      "(3) schema='name' — map all FK relationships within/across a schema. " +
      "(4) column='columnName' — find all tables sharing a column name (implicit join candidates). " +
      "This tool makes the agent a relationship expert — always use it before complex multi-table queries.",
    parameters: {
      type: "object",
      properties: {
        table: {
          type: "string",
          description:
            "Show all foreign key relationships involving this table (both incoming and outgoing). " +
            "Use schema-qualified name: '<schema>.<Table>'."
        },
        between: {
          type: "array",
          items: { type: "string" },
          description:
            "Find FK join paths between two tables. Provide exactly two schema-qualified table names. " +
            "Two schema-qualified table names. Returns up to 5 shortest paths."
        },
        schema: {
          type: "string",
          description:
            "Map all FK relationships within/across a schema. Shows the full relationship graph. " +
            "E.g. 'core' to see how all core tables connect."
        },
        column: {
          type: "string",
          description:
            "Find tables that share a column name (implicit join candidates without formal FKs). " +
            "E.g. 'clientId' finds all tables with a clientId column — potential join points."
        },
        connection: {
          type: "string",
          description: "Named database connection to use. Omit for default."
        }
      },
      required: []
    },

    async execute(args) {
      const connName = args.connection ? String(args.connection).trim() : undefined

      // ── Cache pre-flight (all four modes) ─────────────────────────
      // Relationship topology changes only on DDL; pure data churn never
      // affects the result. We cache by mode-specific cache key and use the
      // catalog-shape fingerprint so schema changes invalidate cleanly.
      if (args.table && typeof args.table === "string") {
        const qn = String(args.table).trim()
        const fp = fingerprintForQname(host, qn, connName)
        const cached = tryServeFromCache(host, "discover_relationships", qn, "fk", connName, fp)
        if (cached !== null) return cached
      } else if (Array.isArray(args.between) && (args.between as unknown[]).length === 2) {
        const pair = (args.between as unknown[]).map((t) => String(t).trim().toLowerCase()).sort()
        const key = `${pair[0]}|${pair[1]}`
        const fp = fingerprintForCatalogBuild(host, connName)
        const cached = tryServeFromCache(host, "discover_relationships", key, "paths", connName, fp)
        if (cached !== null) return cached
      } else if (args.schema && typeof args.schema === "string") {
        const schema = String(args.schema).trim()
        const fp = fingerprintForCatalogBuild(host, connName)
        const cached = tryServeFromCache(host, "discover_relationships", schema, "schema", connName, fp)
        if (cached !== null) return cached
      } else if (args.column && typeof args.column === "string") {
        const col = String(args.column).trim()
        const fp = fingerprintForCatalogBuild(host, connName)
        const cached = tryServeFromCache(host, "discover_relationships", col, "column", connName, fp)
        if (cached !== null) return cached
      }

      let p: sql.ConnectionPool
      try {
        const result = await getPool(host, connName)
        p = result.pool
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`
      }

      try {
        // Mode 1: FK relationships for a specific table
        if (args.table) {
          const tableName = String(args.table)
          const parts = tableName.split(".")
          if (parts.length !== 2) {
            return "Error: table must be schema-qualified (e.g. '<schema>.<Table>'). Use explore_mssql_schema(search='name') to find the full name."
          }
          const request = p.request()
          request.input("schema", sql.NVarChar, parts[0])
          request.input("table", sql.NVarChar, parts[1])
          const result = await request.query(FK_FOR_TABLE)

          if (!result.recordset.length) {
            return (
              `No foreign key relationships found for ${tableName}. ` +
              `This table may use implicit relationships (shared column names without formal FKs). ` +
              `Try: discover_relationships(column='${parts[1]}Id') to find tables with matching columns.`
            )
          }

          const incoming: string[] = []
          const outgoing: string[] = []
          for (const r of result.recordset) {
            const isParent = r.parent_schema === parts[0] && r.parent_table === parts[1]
            const line = `${r.parent_schema}.${r.parent_table}.${r.parent_column} → ${r.referenced_schema}.${r.referenced_table}.${r.referenced_column} (${r.fk_name})`
            if (isParent) outgoing.push(line)
            else incoming.push(line)
          }

          const sections: string[] = [`Relationships for ${tableName}:`]
          if (outgoing.length > 0) {
            sections.push(`\nOutgoing (${tableName} references):`, ...outgoing.map((l) => `  ${l}`))
          }
          if (incoming.length > 0) {
            sections.push(`\nIncoming (referenced BY):`, ...incoming.map((l) => `  ${l}`))
          }
          sections.push(
            `\nTotal: ${outgoing.length} outgoing, ${incoming.length} incoming FK relationships.`,
            `Tip: Use between=['${tableName}','other.Table'] to find indirect paths.`
          )
          const out = sections.join("\n")
          persistToCache(
            host,
            "discover_relationships",
            tableName,
            "fk",
            connName,
            out,
            fingerprintForQname(host, tableName, connName)
          )
          return out
        }

        // Mode 2: Find paths between two tables
        if (args.between) {
          const tables = args.between as string[]
          if (!Array.isArray(tables) || tables.length !== 2) {
            return "Error: 'between' requires exactly two schema-qualified table names."
          }
          const [startTable, endTable] = tables.map((t) => String(t).trim())
          for (const t of [startTable, endTable]) {
            if (!t.includes(".")) {
              return `Error: '${t}' must be schema-qualified (e.g. '<schema>.<Table>').`
            }
          }

          // Load full FK graph
          const result = await p.request().query(FK_ALL)
          const edges: FkEdge[] = result.recordset.map((r: Record<string, string>) => ({
            parentSchema: r.parent_schema,
            parentTable: r.parent_table,
            parentColumn: r.parent_column,
            refSchema: r.referenced_schema,
            refTable: r.referenced_table,
            refColumn: r.referenced_column
          }))

          const adj = buildAdjacency(edges)
          const paths = bfs(adj, startTable, endTable, 5)

          if (paths.length === 0) {
            return (
              `No FK path found between ${startTable} and ${endTable} (max depth 5). ` +
              `These tables may connect via implicit relationships (shared column names). ` +
              `Try: discover_relationships(column='someSharedColumn') to find potential join columns.`
            )
          }

          const sections: string[] = [`Join paths from ${startTable} to ${endTable}:`]
          for (let i = 0; i < paths.length; i++) {
            sections.push(`\nPath ${i + 1} (${paths[i].length} hop${paths[i].length !== 1 ? "s" : ""}):`)
            sections.push(formatPath(paths[i]))
          }
          sections.push(`\n${paths.length} path${paths.length !== 1 ? "s" : ""} found.`)
          const out = sections.join("\n")
          const pair = [startTable, endTable].map((t) => t.toLowerCase()).sort()
          persistToCache(
            host,
            "discover_relationships",
            `${pair[0]}|${pair[1]}`,
            "paths",
            connName,
            out,
            fingerprintForCatalogBuild(host, connName)
          )
          return out
        }

        // Mode 3: Schema-wide FK map
        if (args.schema) {
          const schema = String(args.schema).trim()
          const request = p.request()
          request.input("schema", sql.NVarChar, schema)
          const result = await request.query(FK_FOR_SCHEMA)

          if (!result.recordset.length) {
            return (
              `No foreign key relationships found involving schema '${schema}'. ` +
              `Tables in this schema may use implicit joins. Try explore_mssql_schema(schema='${schema}') to list tables, ` +
              `then discover_relationships(column='someColumn') to find shared columns.`
            )
          }

          // Group by FK name
          const fks = new Map<string, Array<Record<string, string>>>()
          for (const r of result.recordset) {
            const key = r.fk_name
            if (!fks.has(key)) fks.set(key, [])
            fks.get(key)!.push(r)
          }

          const lines: string[] = [
            `FK relationships in/across schema '${schema}' (${fks.size} constraints):\n`
          ]
          for (const [name, cols] of fks) {
            const c = cols[0]
            const colPairs = cols.map((col) => `${col.parent_column} → ${col.referenced_column}`).join(", ")
            lines.push(
              `  ${c.parent_schema}.${c.parent_table} → ${c.referenced_schema}.${c.referenced_table}  [${colPairs}]  (${name})`
            )
          }
          const out = lines.join("\n")
          persistToCache(
            host,
            "discover_relationships",
            schema,
            "schema",
            connName,
            out,
            fingerprintForCatalogBuild(host, connName)
          )
          return out
        }

        // Mode 4: Implicit join candidates by column name
        if (args.column) {
          const colName = String(args.column).trim()
          const request = p.request()
          request.input("pattern", sql.NVarChar, `%${colName}%`)
          const result = await request.query(IMPLICIT_JOINS)

          if (!result.recordset.length) {
            return `No columns matching '${colName}' found. Try a broader pattern.`
          }

          // Group by column name for clarity
          const byCol = new Map<string, Array<{ schema: string; table: string; type: string }>>()
          for (const r of result.recordset) {
            const key = r.column_name as string
            if (!byCol.has(key)) byCol.set(key, [])
            byCol.get(key)!.push({ schema: r.table_schema, table: r.table_name, type: r.data_type })
          }

          const lines: string[] = [`Tables with columns matching '${colName}':\n`]
          for (const [col, tables] of byCol) {
            lines.push(`  Column: ${col} (${tables.length} tables)`)
            // Show first 20, truncate if more
            const show = tables.slice(0, 20)
            for (const t of show) {
              lines.push(`    ${t.schema}.${t.table} (${t.type})`)
            }
            if (tables.length > 20) {
              lines.push(`    ... and ${tables.length - 20} more tables`)
            }
          }
          lines.push(
            `\nThese tables can potentially be JOINed on matching column names.`,
            `Verify data types match before joining. Use explore_mssql_schema(table='schema.Table') to confirm.`
          )
          const out = lines.join("\n")
          persistToCache(
            host,
            "discover_relationships",
            colName,
            "column",
            connName,
            out,
            fingerprintForCatalogBuild(host, connName)
          )
          return out
        }

        return "Error: Provide at least one parameter: table, between, schema, or column."
      } catch (err) {
        return `SQL Error: ${err instanceof Error ? err.message : String(err)}`
      }
    }
  }
}

export const discoverRelationshipsToolMetadata: ToolMetadata = (() => {
  const stub = {} as AgentHost
  const t = buildDiscoverRelationshipsTool(stub)
  return {
    name: t.name,
    description: t.description,
    parameters: t.parameters
  }
})()

export const discoverRelationshipsTool = discoverRelationshipsToolMetadata

export function createDiscoverRelationshipsTool(host: AgentHost): ExecutableTool {
  return buildDiscoverRelationshipsTool(host)
}
