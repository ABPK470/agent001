/**
 * MSSQL relationship discovery tool — deep FK graph traversal,
 * implicit join detection, and path-finding between tables.
 *
 * Gives the agent a relationship-first understanding of the database.
 * Instead of exploring one table at a time, this tool maps the full
 * FK graph and finds join paths between any two tables.
 */

import sql from "mssql"
import type { Tool } from "../types.js"
import { getPool } from "./mssql.js"

// ── FK graph queries ─────────────────────────────────────────────

/** All FK relationships for a specific table (both directions). */
const FK_FOR_TABLE = `
  SELECT
    fk.name                         AS fk_name,
    ps.name                         AS parent_schema,
    pt.name                         AS parent_table,
    pc.name                         AS parent_column,
    rs.name                         AS referenced_schema,
    rt.name                         AS referenced_table,
    rc.name                         AS referenced_column
  FROM sys.foreign_keys fk
  JOIN sys.foreign_key_columns fkc  ON fk.object_id = fkc.constraint_object_id
  JOIN sys.tables pt                ON fkc.parent_object_id = pt.object_id
  JOIN sys.schemas ps               ON pt.schema_id = ps.schema_id
  JOIN sys.columns pc               ON fkc.parent_object_id = pc.object_id AND fkc.parent_column_id = pc.column_id
  JOIN sys.tables rt                ON fkc.referenced_object_id = rt.object_id
  JOIN sys.schemas rs               ON rt.schema_id = rs.schema_id
  JOIN sys.columns rc               ON fkc.referenced_object_id = rc.object_id AND fkc.referenced_column_id = rc.column_id
  WHERE (ps.name = @schema AND pt.name = @table)
     OR (rs.name = @schema AND rt.name = @table)
  ORDER BY fk.name, fkc.constraint_column_id
`

/** All FK relationships within/across a schema. */
const FK_FOR_SCHEMA = `
  SELECT
    fk.name                         AS fk_name,
    ps.name                         AS parent_schema,
    pt.name                         AS parent_table,
    pc.name                         AS parent_column,
    rs.name                         AS referenced_schema,
    rt.name                         AS referenced_table,
    rc.name                         AS referenced_column
  FROM sys.foreign_keys fk
  JOIN sys.foreign_key_columns fkc  ON fk.object_id = fkc.constraint_object_id
  JOIN sys.tables pt                ON fkc.parent_object_id = pt.object_id
  JOIN sys.schemas ps               ON pt.schema_id = ps.schema_id
  JOIN sys.columns pc               ON fkc.parent_object_id = pc.object_id AND fkc.parent_column_id = pc.column_id
  JOIN sys.tables rt                ON fkc.referenced_object_id = rt.object_id
  JOIN sys.schemas rs               ON rt.schema_id = rs.schema_id
  JOIN sys.columns rc               ON fkc.referenced_object_id = rc.object_id AND fkc.referenced_column_id = rc.column_id
  WHERE ps.name = @schema OR rs.name = @schema
  ORDER BY fk.name, fkc.constraint_column_id
`

/** All FK relationships in the database (for BFS path-finding). */
const FK_ALL = `
  SELECT
    ps.name  AS parent_schema,
    pt.name  AS parent_table,
    pc.name  AS parent_column,
    rs.name  AS referenced_schema,
    rt.name  AS referenced_table,
    rc.name  AS referenced_column
  FROM sys.foreign_keys fk
  JOIN sys.foreign_key_columns fkc  ON fk.object_id = fkc.constraint_object_id
  JOIN sys.tables pt                ON fkc.parent_object_id = pt.object_id
  JOIN sys.schemas ps               ON pt.schema_id = ps.schema_id
  JOIN sys.columns pc               ON fkc.parent_object_id = pc.object_id AND fkc.parent_column_id = pc.column_id
  JOIN sys.tables rt                ON fkc.referenced_object_id = rt.object_id
  JOIN sys.schemas rs               ON rt.schema_id = rs.schema_id
  JOIN sys.columns rc               ON fkc.referenced_object_id = rc.object_id AND fkc.referenced_column_id = rc.column_id
`

/** Find tables with column names matching a pattern (implicit join candidates). */
const IMPLICIT_JOINS = `
  SELECT
    s.name   AS table_schema,
    t.name   AS table_name,
    c.name   AS column_name,
    ty.name  AS data_type
  FROM sys.columns c
  JOIN sys.tables t   ON c.object_id = t.object_id
  JOIN sys.schemas s  ON t.schema_id = s.schema_id
  JOIN sys.types ty   ON c.user_type_id = ty.user_type_id
  WHERE c.name LIKE @pattern
  ORDER BY s.name, t.name
`

// ── BFS path finder ──────────────────────────────────────────────

interface FkEdge {
  parentSchema: string
  parentTable: string
  parentColumn: string
  refSchema: string
  refTable: string
  refColumn: string
}

function buildAdjacency(edges: FkEdge[]): Map<string, Array<{ target: string; edge: FkEdge }>> {
  const adj = new Map<string, Array<{ target: string; edge: FkEdge }>>()
  for (const e of edges) {
    const from = `${e.parentSchema}.${e.parentTable}`
    const to = `${e.refSchema}.${e.refTable}`
    if (!adj.has(from)) adj.set(from, [])
    if (!adj.has(to)) adj.set(to, [])
    adj.get(from)!.push({ target: to, edge: e })
    // Bidirectional — FKs can be traversed in either direction
    adj.get(to)!.push({ target: from, edge: e })
  }
  return adj
}

function bfs(
  adj: Map<string, Array<{ target: string; edge: FkEdge }>>,
  start: string,
  end: string,
  maxDepth: number,
): FkEdge[][] {
  const paths: FkEdge[][] = []
  const queue: Array<{ node: string; path: FkEdge[] }> = [{ node: start, path: [] }]
  const visited = new Set<string>()

  while (queue.length > 0 && paths.length < 5) {
    const { node, path } = queue.shift()!
    if (path.length > maxDepth) continue
    if (node === end && path.length > 0) {
      paths.push(path)
      continue
    }
    // Allow revisiting for different paths, but cap visited per depth
    const depthKey = `${node}@${path.length}`
    if (visited.has(depthKey)) continue
    visited.add(depthKey)

    const neighbors = adj.get(node) ?? []
    for (const { target, edge } of neighbors) {
      if (path.some((e) => {
        const eFrom = `${e.parentSchema}.${e.parentTable}`
        const eTo = `${e.refSchema}.${e.refTable}`
        return (eFrom === target || eTo === target) && target !== end
      })) continue // avoid loops (except target)
      queue.push({ node: target, path: [...path, edge] })
    }
  }
  return paths
}

function formatPath(path: FkEdge[]): string {
  if (path.length === 0) return "(direct)"
  const steps: string[] = []
  for (const e of path) {
    steps.push(
      `  ${e.parentSchema}.${e.parentTable}.${e.parentColumn} → ${e.refSchema}.${e.refTable}.${e.refColumn}`,
    )
  }
  return steps.join("\n")
}

// ── The tool ─────────────────────────────────────────────────────

export const discoverRelationshipsTool: Tool = {
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
          "Use schema-qualified name: 'core.Dataset', 'dim.Client', 'fact.AfricaFlex'.",
      },
      between: {
        type: "array",
        items: { type: "string" },
        description:
          "Find FK join paths between two tables. Provide exactly two schema-qualified table names. " +
          "E.g. ['dim.Client', 'fact.AfricaFlexDailyBalances']. Returns up to 5 shortest paths.",
      },
      schema: {
        type: "string",
        description:
          "Map all FK relationships within/across a schema. Shows the full relationship graph. " +
          "E.g. 'core' to see how all core tables connect.",
      },
      column: {
        type: "string",
        description:
          "Find tables that share a column name (implicit join candidates without formal FKs). " +
          "E.g. 'clientId' finds all tables with a clientId column — potential join points.",
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
      const result = await getPool(connName)
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
          return "Error: table must be schema-qualified (e.g. 'core.Dataset'). Use explore_mssql_schema(search='name') to find the full name."
        }
        const request = p.request()
        request.input("schema", sql.NVarChar, parts[0])
        request.input("table", sql.NVarChar, parts[1])
        const result = await request.query(FK_FOR_TABLE)

        if (!result.recordset.length) {
          return `No foreign key relationships found for ${tableName}. ` +
            `This table may use implicit relationships (shared column names without formal FKs). ` +
            `Try: discover_relationships(column='${parts[1]}Id') to find tables with matching columns.`
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
          `Tip: Use between=['${tableName}','other.Table'] to find indirect paths.`,
        )
        return sections.join("\n")
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
            return `Error: '${t}' must be schema-qualified (e.g. 'dim.Client').`
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
          refColumn: r.referenced_column,
        }))

        const adj = buildAdjacency(edges)
        const paths = bfs(adj, startTable, endTable, 5)

        if (paths.length === 0) {
          return `No FK path found between ${startTable} and ${endTable} (max depth 5). ` +
            `These tables may connect via implicit relationships (shared column names). ` +
            `Try: discover_relationships(column='someSharedColumn') to find potential join columns.`
        }

        const sections: string[] = [`Join paths from ${startTable} to ${endTable}:`]
        for (let i = 0; i < paths.length; i++) {
          sections.push(`\nPath ${i + 1} (${paths[i].length} hop${paths[i].length !== 1 ? "s" : ""}):`)
          sections.push(formatPath(paths[i]))
        }
        sections.push(`\n${paths.length} path${paths.length !== 1 ? "s" : ""} found.`)
        return sections.join("\n")
      }

      // Mode 3: Schema-wide FK map
      if (args.schema) {
        const schema = String(args.schema).trim()
        const request = p.request()
        request.input("schema", sql.NVarChar, schema)
        const result = await request.query(FK_FOR_SCHEMA)

        if (!result.recordset.length) {
          return `No foreign key relationships found involving schema '${schema}'. ` +
            `Tables in this schema may use implicit joins. Try explore_mssql_schema(schema='${schema}') to list tables, ` +
            `then discover_relationships(column='someColumn') to find shared columns.`
        }

        // Group by FK name
        const fks = new Map<string, Array<Record<string, string>>>()
        for (const r of result.recordset) {
          const key = r.fk_name
          if (!fks.has(key)) fks.set(key, [])
          fks.get(key)!.push(r)
        }

        const lines: string[] = [`FK relationships in/across schema '${schema}' (${fks.size} constraints):\n`]
        for (const [name, cols] of fks) {
          const c = cols[0]
          const colPairs = cols.map((col) => `${col.parent_column} → ${col.referenced_column}`).join(", ")
          lines.push(`  ${c.parent_schema}.${c.parent_table} → ${c.referenced_schema}.${c.referenced_table}  [${colPairs}]  (${name})`)
        }
        return lines.join("\n")
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
          `Verify data types match before joining. Use explore_mssql_schema(table='schema.Table') to confirm.`,
        )
        return lines.join("\n")
      }

      return "Error: Provide at least one parameter: table, between, schema, or column."
    } catch (err) {
      return `SQL Error: ${err instanceof Error ? err.message : String(err)}`
    }
  },
}
