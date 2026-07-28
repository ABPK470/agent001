/**
 * Flatten day-grouped pipelines into a virtualizable row model.
 */

import type { OperationPipeline } from "../client/index"

export type OperationFlatRow =
  | { type: "day"; key: string; label: string; count: number }
  | { type: "pipeline"; key: string; pipeline: OperationPipeline }

export function flattenOperationRows(
  pipelines: readonly OperationPipeline[],
  collapsedDays: ReadonlySet<string>,
  dayLabelOf: (iso: string) => string,
): OperationFlatRow[] {
  const rows: OperationFlatRow[] = []
  let curLabel: string | null = null
  let curItems: OperationPipeline[] = []

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
        })
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
  return rows
}
