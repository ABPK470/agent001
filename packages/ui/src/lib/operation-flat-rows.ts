/**
 * Flatten day-grouped pipelines (+ optional open activity trees) into a
 * virtualizable row model for the left master tree.
 */

import type { ReviewTreeGuideSlot } from "../components/review/review-tree-guides"
import { annotateTreeGuideSlots } from "../components/review/review-tree-guides"
import type { OperationActivity, OperationPipeline } from "../client/index"

export type OperationFlatRow =
  | { type: "day"; key: string; label: string; count: number }
  | {
      type: "pipeline"
      key: string
      pipeline: OperationPipeline
      depth: 0
      parentScopeId: null
      guideSlots: ReviewTreeGuideSlot[]
    }
  | {
      type: "activity"
      key: string
      pipeline: OperationPipeline
      activity: OperationActivity
      activityKey: string
      depth: number
      hasChildren: boolean
      parentPhaseId?: string
      parentScopeId: string
      guideSlots: ReviewTreeGuideSlot[]
    }

type GuideAnnotated = {
  depth: number
  parentScopeId: string | null
  guideSlots?: ReviewTreeGuideSlot[]
}

export function flattenOperationRows(
  pipelines: readonly OperationPipeline[],
  collapsedDays: ReadonlySet<string>,
  dayLabelOf: (iso: string) => string,
  opts?: {
    openPipelineIds?: ReadonlySet<string>
    openActivityKeys?: ReadonlySet<string>
    activityKeyOf?: (pipelineId: string, activityId: string, parentKey?: string) => string
  },
): OperationFlatRow[] {
  const rows: OperationFlatRow[] = []
  let curLabel: string | null = null
  let curItems: OperationPipeline[] = []
  const openPipelineIds = opts?.openPipelineIds
  const openActivityKeys = opts?.openActivityKeys
  const activityKeyOf = opts?.activityKeyOf

  function pushActivities(
    pipeline: OperationPipeline,
    activities: readonly OperationActivity[],
    depth: number,
    parentScopeId: string,
    parentKey?: string,
    parentPhaseId?: string,
  ): void {
    if (!activityKeyOf || !openActivityKeys) return
    for (const activity of activities) {
      const activityKey = activityKeyOf(pipeline.id, activity.id, parentKey)
      const hasChildren = (activity.children?.length ?? 0) > 0
      const phaseId = activity.id.startsWith("phase:") ? activity.id : parentPhaseId
      rows.push({
        type: "activity",
        key: activityKey,
        pipeline,
        activity,
        activityKey,
        depth,
        hasChildren,
        parentPhaseId: phaseId,
        parentScopeId,
        guideSlots: [],
      })
      if (hasChildren && openActivityKeys.has(activityKey)) {
        pushActivities(pipeline, activity.children!, depth + 1, activityKey, activityKey, phaseId)
      }
    }
  }

  function flush(): void {
    if (curLabel == null) return
    rows.push({
      type: "day",
      key: `day:${curLabel}`,
      label: curLabel,
      count: curItems.length,
    })
    if (!collapsedDays.has(curLabel)) {
      for (const pipeline of curItems) {
        rows.push({
          type: "pipeline",
          key: pipeline.id,
          pipeline,
          depth: 0,
          parentScopeId: null,
          guideSlots: [],
        })
        if (openPipelineIds?.has(pipeline.id) && activityKeyOf && openActivityKeys) {
          // Depth 1 = first nest under pipeline root (Trace dialect: +1 indent step).
          pushActivities(pipeline, pipeline.activities, 1, pipeline.id)
        }
      }
    }
    curItems = []
  }

  for (const pipeline of pipelines) {
    const label = dayLabelOf(pipeline.startedAt)
    if (curLabel !== label) {
      flush()
      curLabel = label
    }
    curItems.push(pipeline)
  }
  flush()

  const guideNodes: GuideAnnotated[] = rows.map((row) => {
    if (row.type === "day") return { depth: -1, parentScopeId: null }
    return row
  })
  annotateTreeGuideSlots(guideNodes)
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!
    if (row.type === "day") continue
    row.guideSlots = guideNodes[i]!.guideSlots ?? []
  }

  return rows
}
