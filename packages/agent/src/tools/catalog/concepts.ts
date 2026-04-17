import type { ConceptNode, ViewLineage } from "./types.js"

/**
 * Rebuild concept graph from all current lineage maps.
 * For each view lineage, derives a ConceptNode (name = view's own name without schema)
 * and builds bi-directional indexes:
 *   conceptNodes["revenue"] → ConceptNode
 *   conceptEdgeIndex["publish.MappingTransactionalBanking"] → [ConceptNode(Revenue)]
 *   conceptEdgeIndex["publish.Revenue"] → [ConceptNode(Revenue)]  ← the view itself
 *
 * Clears all three maps before rebuilding.
 */
export function buildConceptGraph(
  conceptNodes: Map<string, ConceptNode>,
  conceptByView: Map<string, ConceptNode>,
  conceptEdgeIndex: Map<string, ConceptNode[]>,
  lineages: ViewLineage[],
): void {
  conceptNodes.clear()
  conceptByView.clear()
  conceptEdgeIndex.clear()

  for (const l of lineages) {
    const concept = l.view.includes(".") ? l.view.split(".").pop()! : l.view
    const tables = [...new Set(l.sources.map((s) => s.qualifiedName))]
    const businessGroups = [...new Set(l.sources.map((s) => s.group))]
    const node: ConceptNode = { concept, sourceView: l.view, description: l.description, tables, businessGroups }

    conceptNodes.set(concept.toLowerCase(), node)
    conceptByView.set(l.view.toLowerCase(), node)

    // Reverse index: source tables → concepts they contribute to
    for (const tk of tables) {
      if (!conceptEdgeIndex.has(tk)) conceptEdgeIndex.set(tk, [])
      if (!conceptEdgeIndex.get(tk)!.some((n) => n.concept === concept)) {
        conceptEdgeIndex.get(tk)!.push(node)
      }
    }
    // The source view itself belongs to its own concept
    if (!conceptEdgeIndex.has(l.view)) conceptEdgeIndex.set(l.view, [])
    if (!conceptEdgeIndex.get(l.view)!.some((n) => n.concept === concept)) {
      conceptEdgeIndex.get(l.view)!.push(node)
    }
  }
}
