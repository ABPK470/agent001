import { tableKey } from "./helpers.js"
import type {
    CatalogFK,
    CatalogTable,
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
