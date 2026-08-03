/**
 * IDE-style tree guide slots for flat virtualized Pipelines rows.
 * Indent is one fixed slot per depth level (├ branch / └ corner / │ line).
 */

export type ReviewTreeGuideSlot = "blank" | "line" | "branch" | "corner"

type GuideNode = { depth: number; parentScopeId: string | null }

export function isLastSibling(nodes: GuideNode[], index: number): boolean {
  const node = nodes[index]
  if (!node) return true
  for (let j = index + 1; j < nodes.length; j++) {
    const next = nodes[j]!
    if (next.depth < node.depth) return true
    if (next.depth === node.depth && next.parentScopeId === node.parentScopeId) {
      return false
    }
  }
  return true
}

/**
 * Vertical guide at column `level` continues through this row only when a later
 * sibling still exists at depth `level + 1` (before the subtree ends).
 *
 * Important: a deeper descendant (depth > level + 1) is not enough — otherwise
 * children of a └ parent keep painting a phantom stem in the parent column
 * (e.g. far-left line through Execute’s kids after Execute itself was corner).
 */
export function shouldDrawGuideLine(
  nodes: Array<{ depth: number }>,
  index: number,
  level: number,
): boolean {
  for (let j = index + 1; j < nodes.length; j++) {
    const depth = nodes[j]!.depth
    if (depth <= level) return false
    if (depth === level + 1) return true
  }
  return false
}

export function buildGuideSlots(nodes: GuideNode[], index: number): ReviewTreeGuideSlot[] {
  const node = nodes[index]
  if (!node || node.depth <= 0) return []

  const slots: ReviewTreeGuideSlot[] = []
  for (let level = 0; level < node.depth - 1; level++) {
    slots.push(shouldDrawGuideLine(nodes, index, level) ? "line" : "blank")
  }
  slots.push(isLastSibling(nodes, index) ? "corner" : "branch")
  return slots
}

export function annotateTreeGuideSlots<
  T extends GuideNode & { guideSlots?: ReviewTreeGuideSlot[] },
>(nodes: T[]): void {
  for (let i = 0; i < nodes.length; i++) {
    nodes[i]!.guideSlots = buildGuideSlots(nodes, i)
  }
}
