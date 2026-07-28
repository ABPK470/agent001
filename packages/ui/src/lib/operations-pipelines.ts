/**
 * Pure merge helpers for operations pipelines (no transport).
 */

import type { OperationPipeline } from "../client/index"

/** Must match server OPERATIONS_PAGE_EVENT_LIMIT. */
export const OPERATIONS_PAGE_EVENT_LIMIT = 2000

export type OperationLogKindView = "all" | "agent" | "sync" | "bridge"

export function mergeOperationPipelines(
  ...groups: OperationPipeline[][]
): OperationPipeline[] {
  const byId = new Map<string, OperationPipeline>()
  for (const group of groups) {
    for (const pipeline of group) {
      const existing = byId.get(pipeline.id)
      if (!existing || pipeline.eventCount > existing.eventCount) {
        byId.set(pipeline.id, pipeline)
      }
    }
  }
  return [...byId.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt))
}

/** Merge a fresh head page with older pages already loaded via scroll. */
export function mergeHeadRefresh(
  current: OperationPipeline[],
  head: OperationPipeline[],
  oldestHeadTimestamp: string | null,
): OperationPipeline[] {
  if (!oldestHeadTimestamp) return head
  const headIds = new Set(head.map((p) => p.id))
  const tail = current.filter(
    (p) => !headIds.has(p.id) && p.startedAt < oldestHeadTimestamp,
  )
  return mergeOperationPipelines(head, tail)
}
