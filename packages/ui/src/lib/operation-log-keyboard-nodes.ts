/**
 * Map operation-log flat rows to review tree keyboard nodes.
 * Day section headers are omitted — arrows move pipeline/activity rows only.
 */

import type { ReviewTreeKeyboardNode } from "../components/review/review-tree-keyboard"
import type { OperationFlatRow } from "./operation-flat-rows"

export function buildOperationLogKeyboardNodes(
  rows: readonly OperationFlatRow[],
): ReviewTreeKeyboardNode[] {
  const nodes: ReviewTreeKeyboardNode[] = []
  for (let flatIndex = 0; flatIndex < rows.length; flatIndex++) {
    const row = rows[flatIndex]!
    if (row.type === "day") continue
    if (row.type === "pipeline") {
      nodes.push({
        scopeId: row.pipeline.id,
        parentScopeId: null,
        hasChildren: row.pipeline.activities.length > 0,
        flatIndex,
      })
      continue
    }
    nodes.push({
      scopeId: row.activityKey,
      parentScopeId: row.parentScopeId,
      hasChildren: row.hasChildren,
      flatIndex,
    })
  }
  return nodes
}

export function selectedScopeIdFromOpLogSelection(
  selection: { kind: "pipeline"; pipelineId: string } | { kind: "activity"; activityKey: string } | null,
): string | null {
  if (!selection) return null
  return selection.kind === "pipeline" ? selection.pipelineId : selection.activityKey
}
