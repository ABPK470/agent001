import { tableKey } from "./helpers.js"
import type {
    CatalogFK,
    CatalogTable,
    ConceptNode,
    ConceptPathEdge,
    ConceptPathResult,
    ConceptPathStep,
    ImplicitEdge,
} from "./types.js"

/** BFS path-finding between two tables via FK edges only. */
export function findFkPath(
  tables: Map<string, CatalogTable>,
  adjacency: Map<string, Array<{ target: string; fk: CatalogFK }>>,
  from: string,
  to: string,
  maxDepth: number,
): CatalogFK[][] {
  if (!tables.has(from) || !tables.has(to)) return []

  const paths: CatalogFK[][] = []
  const queue: Array<{ node: string; path: CatalogFK[] }> = [{ node: from, path: [] }]
  const visited = new Set<string>()

  while (queue.length > 0 && paths.length < 5) {
    const { node, path } = queue.shift()!
    if (path.length > maxDepth) continue
    if (node === to && path.length > 0) { paths.push(path); continue }

    const depthKey = `${node}@${path.length}`
    if (visited.has(depthKey)) continue
    visited.add(depthKey)

    for (const { target, fk } of (adjacency.get(node) ?? [])) {
      if (
        path.some((e) => tableKey(e.fromSchema, e.fromTable) === target || tableKey(e.toSchema, e.toTable) === target) &&
        target !== to
      ) continue
      queue.push({ node: target, path: [...path, fk] })
    }
  }
  return paths
}

function pathVisited(steps: ConceptPathStep[], node: string): boolean {
  return steps.some((s) => s.from === node || s.to === node)
}

/**
 * Concept-aware path finding between two tables.
 *
 * Traverses three edge types:
 *   • FK edges        — declared FK constraints (structural)
 *   • Implicit edges  — shared column name + type (inferred)
 *   • Concept edges   — tables sharing a business concept via lineage:
 *       tableA ──[concept:Revenue]──> publish.Revenue ──[concept:Revenue]──> tableB
 *
 * This surfaces semantic relationships that pure FK traversal cannot find.
 * E.g. fact.CommissionAllocation → publish.Revenue even with no FK between them.
 */
export function findConceptPath(
  tables: Map<string, CatalogTable>,
  adjacency: Map<string, Array<{ target: string; fk: CatalogFK }>>,
  implicitJoinIndex: Map<string, ImplicitEdge[]>,
  conceptEdgeIndex: Map<string, ConceptNode[]>,
  from: string,
  to: string,
  maxDepth: number,
): ConceptPathResult[] {
  if (!tables.has(from) || !tables.has(to)) return []

  const results: ConceptPathResult[] = []
  const queue: Array<{ node: string; steps: ConceptPathStep[] }> = [{ node: from, steps: [] }]
  const visited = new Set<string>()

  while (queue.length > 0 && results.length < 5) {
    const { node, steps } = queue.shift()!
    if (steps.length > maxDepth) continue

    if (node === to && steps.length > 0) {
      const conceptsUsed = [...new Set(
        steps
          .filter((s) => s.edge.type === "concept")
          .map((s) => (s.edge as { type: "concept"; concept: string; via: string }).concept),
      )]
      results.push({ steps, totalHops: steps.length, conceptsUsed })
      continue
    }

    const depthKey = `${node}@${steps.length}`
    if (visited.has(depthKey)) continue
    visited.add(depthKey)

    // 1. FK edges (structural — declared FK constraints)
    for (const { target, fk } of (adjacency.get(node) ?? [])) {
      if (pathVisited(steps, target) && target !== to) continue
      queue.push({
        node: target,
        steps: [...steps, { from: node, edge: { type: "fk", fromColumn: fk.fromColumn, toColumn: fk.toColumn }, to: target }],
      })
    }

    // 2. Implicit join edges (inferred — shared column name + compatible type)
    for (const edge of (implicitJoinIndex.get(node) ?? [])) {
      for (const target of edge.tables) {
        if (target === node) continue
        if (pathVisited(steps, target) && target !== to) continue
        queue.push({
          node: target,
          steps: [...steps, { from: node, edge: { type: "implicit", column: edge.column, dataType: edge.dataType }, to: target }],
        })
      }
    }

    // 3. Concept edges (semantic — route through source view as hub)
    //    tableA → sourceView:  contributing table reaches the aggregating view
    //    sourceView → tableB:  the aggregating view fans out to all contributors
    for (const conceptNode of (conceptEdgeIndex.get(node) ?? [])) {
      const hub = conceptNode.sourceView
      const conceptEdge: ConceptPathEdge = { type: "concept", concept: conceptNode.concept, via: hub }

      if (node !== hub) {
        // This node is a contributing table → step toward the source view (hub)
        if (!pathVisited(steps, hub) || hub === to) {
          queue.push({ node: hub, steps: [...steps, { from: node, edge: conceptEdge, to: hub }] })
        }
      } else {
        // This node IS the source view → fan out to all contributing tables
        for (const target of conceptNode.tables) {
          if (target === node) continue
          if (pathVisited(steps, target) && target !== to) continue
          queue.push({ node: target, steps: [...steps, { from: node, edge: conceptEdge, to: target }] })
        }
      }
    }
  }

  return results
}
