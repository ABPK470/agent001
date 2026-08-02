/**
 * IDE-style tree guide slots for flat trace tree rows.
 */

export const TRACE_TREE_BASE_PAD_PX = 16
export const TRACE_TREE_INDENT_PX = 20
export const TRACE_TREE_GUIDE_SLOT_PX = TRACE_TREE_INDENT_PX

export type TraceTreeGuideSlot = "blank" | "line" | "branch" | "corner"

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

/** Vertical guide at column `level` continues through this row. */
export function shouldDrawGuideLine(
  nodes: Array<{ depth: number }>,
  index: number,
  level: number,
): boolean {
  for (let j = index + 1; j < nodes.length; j++) {
    const next = nodes[j]!
    if (next.depth <= level) return false
    return true
  }
  return false
}

export function buildGuideSlots(nodes: GuideNode[], index: number): TraceTreeGuideSlot[] {
  const node = nodes[index]
  if (!node || node.depth <= 0) return []

  const slots: TraceTreeGuideSlot[] = []
  for (let level = 0; level < node.depth - 1; level++) {
    slots.push(shouldDrawGuideLine(nodes, index, level) ? "line" : "blank")
  }
  slots.push(isLastSibling(nodes, index) ? "corner" : "branch")
  return slots
}

export function annotateTreeGuideSlots<
  T extends GuideNode & { guideSlots?: TraceTreeGuideSlot[] },
>(nodes: T[]): void {
  for (let i = 0; i < nodes.length; i++) {
    nodes[i]!.guideSlots = buildGuideSlots(nodes, i)
  }
}
