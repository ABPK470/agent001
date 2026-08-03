import type { OperationActivity, OperationPipeline } from "../../client/index"
import type { ReviewTreeFoldMode } from "../../components/review"

export type { ReviewTreeFoldMode as OpLogTreeFoldMode } from "../../components/review"

export type ActivityKeyOf = (
  pipelineId: string,
  activityId: string,
  parentKey?: string,
) => string

export type OpLogTreeOpenState = {
  openPipelineIds: Set<string>
  actExpanded: Set<string>
  collapsedDays: Set<string>
  foldMode: ReviewTreeFoldMode
}

function walkExpandableActivityKeys(
  pipeline: OperationPipeline,
  activities: readonly OperationActivity[],
  activityKeyOf: ActivityKeyOf,
  keys: Set<string>,
  parentKey?: string,
): void {
  for (const activity of activities) {
    const key = activityKeyOf(pipeline.id, activity.id, parentKey)
    if ((activity.children?.length ?? 0) > 0) {
      keys.add(key)
      walkExpandableActivityKeys(pipeline, activity.children!, activityKeyOf, keys, key)
    }
  }
}

export function collectExpandableActivityKeys(
  pipelines: readonly OperationPipeline[],
  activityKeyOf: ActivityKeyOf,
): Set<string> {
  const keys = new Set<string>()
  for (const pipeline of pipelines) {
    walkExpandableActivityKeys(pipeline, pipeline.activities, activityKeyOf, keys)
  }
  return keys
}

export function expandedTreeOpenState(
  pipelines: readonly OperationPipeline[],
  activityKeyOf: ActivityKeyOf,
): OpLogTreeOpenState {
  return {
    openPipelineIds: new Set(pipelines.map((p) => p.id)),
    actExpanded: collectExpandableActivityKeys(pipelines, activityKeyOf),
    collapsedDays: new Set(),
    foldMode: "expanded",
  }
}

export function collapsedTreeOpenState(): OpLogTreeOpenState {
  return {
    openPipelineIds: new Set(),
    actExpanded: new Set(),
    collapsedDays: new Set(),
    foldMode: "collapsed",
  }
}

export function treeOpenStateForFoldMode(
  pipelines: readonly OperationPipeline[],
  mode: ReviewTreeFoldMode,
  activityKeyOf: ActivityKeyOf,
): OpLogTreeOpenState {
  return mode === "expanded"
    ? expandedTreeOpenState(pipelines, activityKeyOf)
    : collapsedTreeOpenState()
}
