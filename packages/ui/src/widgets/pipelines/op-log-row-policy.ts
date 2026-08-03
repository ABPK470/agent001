import type { OperationActivity, OperationStatus } from "../../client/index"
import { OperationStatus as OS } from "../../client/index"

/** Non-pipeline rows — failures and in-flight only (no OK / skip / cancel pills). */
const CHILD_PILL_STATUSES = new Set<OperationStatus>([OS.Failed, OS.Running])

export function opLogShowStatusPill(opts: {
  pipelineRow?: boolean
  status: OperationStatus
}): boolean {
  if (opts.pipelineRow) return true
  return CHILD_PILL_STATUSES.has(opts.status)
}

/**
 * Kind (entity) icons belong on pipeline roots only.
 * Nested stages use functional icons / status dots via `resolveActivityTreeVisual`.
 * Inspector timeline stays icon-free.
 */
export function opLogShowEntityIcon(opts: { pipelineRow?: boolean }): boolean {
  return !!opts.pipelineRow
}
