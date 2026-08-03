import type { OperationStatus } from "../../client/index"
import { OperationStatus as OS } from "../../client/index"

/**
 * Information de-escalation:
 *   Root / summary rows → full status pill (OK + FAIL)
 *   Stage rows          → FAIL / Running only (OK is implied by green path)
 *   Leaf rows           → FAIL / Running only; OK is the status dot alone
 */
const ATTENTION_PILL_STATUSES = new Set<OperationStatus>([OS.Failed, OS.Running])

export function opLogShowStatusPill(opts: {
  pipelineRow?: boolean
  /** Leaf under a stage — never OK pill (dot carries success). */
  leaf?: boolean
  status: OperationStatus
}): boolean {
  if (opts.pipelineRow) return true
  return ATTENTION_PILL_STATUSES.has(opts.status)
}

/**
 * Kind (entity) icons belong on pipeline roots only.
 * Nested stages use functional icons / status dots via `resolveActivityTreeVisual`.
 * Inspector timeline stays icon-free.
 */
export function opLogShowEntityIcon(opts: { pipelineRow?: boolean }): boolean {
  return !!opts.pipelineRow
}
