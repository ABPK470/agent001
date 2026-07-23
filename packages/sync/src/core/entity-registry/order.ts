import type { EntityDefinition, EntityTable } from "../../domain/entity-registry/types.js"

export interface EntityTableOrderEdge {
  parent: string
  child: string
  reason: string
}

export interface EntityTableOrderViolation extends EntityTableOrderEdge {
  parentIndex: number
  childIndex: number
}

export function orderEntityTables(def: Pick<EntityDefinition, "rootTable" | "tables">): EntityTable[] {
  return orderEntityTablesDetailed(def).tables
}

/** Assign contiguous 1-based executionOrder values in current sort order. */
export function renumberEntityTablesExecutionOrder(tables: readonly EntityTable[]): EntityTable[] {
  return [...tables]
    .map((table, idx) => ({ table, idx }))
    .sort(
      (left, right) =>
        Number(left.table.executionOrder ?? 0) - Number(right.table.executionOrder ?? 0) ||
        left.idx - right.idx,
    )
    .map(({ table }, index) => ({
      ...table,
      executionOrder: index + 1,
    }))
}

export function orderEntityTablesDetailed(def: Pick<EntityDefinition, "rootTable" | "tables">): {
  tables: EntityTable[]
  cycleDetected: boolean
  edges: EntityTableOrderEdge[]
} {
  const nodes = def.tables.map((table, idx) => ({ table, idx, key: table.name.toLowerCase() }))
  const edges = listEntityTableOrderEdges(def)
  const nodeByKey = new Map(nodes.map((node) => [node.key, node]))
  const outgoing = new Map<string, Set<string>>()
  const indegree = new Map<string, number>(nodes.map((node) => [node.key, 0]))

  for (const edge of edges) {
    const parent = edge.parent.toLowerCase()
    const child = edge.child.toLowerCase()
    if (!nodeByKey.has(parent) || !nodeByKey.has(child) || parent === child) continue
    let children = outgoing.get(parent)
    if (!children) {
      children = new Set<string>()
      outgoing.set(parent, children)
    }
    if (children.has(child)) continue
    children.add(child)
    indegree.set(child, (indegree.get(child) ?? 0) + 1)
  }

  const compare = (leftKey: string, rightKey: string) =>
    compareNodes(nodeByKey.get(leftKey)!, nodeByKey.get(rightKey)!, def.rootTable)

  const ready = [...nodes.filter((node) => (indegree.get(node.key) ?? 0) === 0).map((node) => node.key)].sort(
    compare
  )
  const orderedKeys: string[] = []

  while (ready.length > 0) {
    const key = ready.shift()!
    orderedKeys.push(key)
    const children = outgoing.get(key)
    if (!children) continue
    for (const child of children) {
      indegree.set(child, (indegree.get(child) ?? 0) - 1)
      if ((indegree.get(child) ?? 0) === 0) {
        ready.push(child)
        ready.sort(compare)
      }
    }
  }

  const cycleDetected = orderedKeys.length !== nodes.length
  if (cycleDetected) {
    const remaining = nodes
      .filter((node) => !orderedKeys.includes(node.key))
      .sort((left, right) => compareNodes(left, right, def.rootTable))
      .map((node) => node.key)
    orderedKeys.push(...remaining)
  }

  return {
    tables: orderedKeys.map((key) => nodeByKey.get(key)!.table),
    cycleDetected,
    edges
  }
}

export function listEntityTableOrderEdges(
  def: Pick<EntityDefinition, "rootTable" | "tables">
): EntityTableOrderEdge[] {
  void def
  return []
}

export function findEntityTableOrderViolations(
  def: Pick<EntityDefinition, "rootTable" | "tables">
): EntityTableOrderViolation[] {
  const ordered = def.tables
    .map((table, idx) => ({ table, idx }))
    .sort(
      (left, right) =>
        Number(left.table.executionOrder ?? 0) - Number(right.table.executionOrder ?? 0) ||
        left.idx - right.idx
    )
  const positions = new Map(ordered.map((entry, index) => [entry.table.name.toLowerCase(), index]))
  const violations: EntityTableOrderViolation[] = []

  for (const edge of listEntityTableOrderEdges(def)) {
    const parentIndex = positions.get(edge.parent.toLowerCase())
    const childIndex = positions.get(edge.child.toLowerCase())
    if (parentIndex == null || childIndex == null) continue
    if (parentIndex > childIndex) {
      violations.push({ ...edge, parentIndex, childIndex })
    }
  }

  return violations
}

function compareNodes(
  left: { table: EntityTable; idx: number },
  right: { table: EntityTable; idx: number },
  _rootTable: string
): number {
  return (
    Number(left.table.executionOrder ?? 0) - Number(right.table.executionOrder ?? 0) || left.idx - right.idx
  )
}
