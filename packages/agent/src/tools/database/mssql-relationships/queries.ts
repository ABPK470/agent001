/**
 * SQL queries + FK graph helpers for mssql-relationships tool.
 * Extracted from mssql-relationships.ts.
 *
 * @module
 */

/** All FK relationships for a specific table (both directions). */
export const FK_FOR_TABLE = `
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
export const FK_FOR_SCHEMA = `
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
export const FK_ALL = `
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
export const IMPLICIT_JOINS = `
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

export interface FkEdge {
  parentSchema: string
  parentTable: string
  parentColumn: string
  refSchema: string
  refTable: string
  refColumn: string
}

export function buildAdjacency(edges: FkEdge[]): Map<string, Array<{ target: string; edge: FkEdge }>> {
  const adj = new Map<string, Array<{ target: string; edge: FkEdge }>>()
  for (const e of edges) {
    const from = `${e.parentSchema}.${e.parentTable}`
    const to = `${e.refSchema}.${e.refTable}`
    if (!adj.has(from)) adj.set(from, [])
    if (!adj.has(to)) adj.set(to, [])
    adj.get(from)!.push({ target: to, edge: e })
    adj.get(to)!.push({ target: from, edge: e })
  }
  return adj
}

export function bfs(
  adj: Map<string, Array<{ target: string; edge: FkEdge }>>,
  start: string,
  end: string,
  maxDepth: number
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
    const depthKey = `${node}@${path.length}`
    if (visited.has(depthKey)) continue
    visited.add(depthKey)

    const neighbors = adj.get(node) ?? []
    for (const { target, edge } of neighbors) {
      if (
        path.some((e) => {
          const eFrom = `${e.parentSchema}.${e.parentTable}`
          const eTo = `${e.refSchema}.${e.refTable}`
          return (eFrom === target || eTo === target) && target !== end
        })
      )
        continue
      queue.push({ node: target, path: [...path, edge] })
    }
  }
  return paths
}

export function formatPath(path: FkEdge[]): string {
  if (path.length === 0) return "(direct)"
  const steps: string[] = []
  for (const e of path) {
    steps.push(
      `  ${e.parentSchema}.${e.parentTable}.${e.parentColumn} → ${e.refSchema}.${e.refTable}.${e.refColumn}`
    )
  }
  return steps.join("\n")
}
