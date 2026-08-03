/**
 * Left-tree activity row — select drives the right detail pane; chevron folds children.
 * Icon hierarchy: stage = functional icon; leaf = status dot (no kind inflation).
 */

import type { OperationActivity, OperationStatus } from "../../client/index"
import { ReviewTreeRow } from "../../components/review"
import type { ReviewTreeGuideSlot } from "../../components/review/review-tree-guides"
import { resolveActivityTreeVisual } from "./op-log-entity-icon"
import { OpLogEntityIcon } from "./OpLogEntityIcon"
import { OpLogStatusDot } from "./OpLogStatusDot"
import { OpLogStatusPill } from "./OpLogStatusPill"
import { OP_LOG, OP_LOG_DESC, fmtDuration } from "./operation-log-row"
import { opLogShowStatusPill } from "./op-log-row-policy"

const REVIEW_TREE_GRID_COLS = "minmax(0, 1fr) var(--review-tree-col-duration)"

export function OperationLogActivityTreeRow({
  activity,
  label,
  summary,
  status,
  depth,
  selected,
  hasChildren,
  folded,
  guideSlots,
  onSelect,
  onToggleFold,
}: {
  activity: OperationActivity
  label: string
  summary?: string
  status: OperationStatus
  depth: number
  selected: boolean
  hasChildren: boolean
  folded: boolean
  guideSlots?: readonly ReviewTreeGuideSlot[]
  onSelect: () => void
  onToggleFold: () => void
}) {
  // Leaves: status dot only for OK; FAIL/Running keep the pill (errors must break flow).
  const showPill = opLogShowStatusPill({ status, leaf: !hasChildren })
  const visual = resolveActivityTreeVisual({ activity, hasChildren, status })
  const icon =
    visual.type === "icon" ? (
      <OpLogEntityIcon icon={visual.Icon} color={visual.color} />
    ) : (
      <OpLogStatusDot status={visual.status} />
    )

  return (
    <ReviewTreeRow
      depth={depth}
      selected={selected}
      hasChildren={hasChildren}
      folded={folded}
      isRoot={depth === 0}
      rowClassName="op-log-activity-tree-row"
      gridTemplateColumns={REVIEW_TREE_GRID_COLS}
      guideSlots={guideSlots}
      onSelect={onSelect}
      onToggleFold={onToggleFold}
      icon={icon}
      title={
        <span className={OP_LOG} title={label}>
          {label}
          {summary ? (
            <>
              <span className={OP_LOG_DESC}> · </span>
              <span className={`${OP_LOG_DESC} font-normal`}>{summary}</span>
            </>
          ) : null}
        </span>
      }
      trailing={showPill ? <OpLogStatusPill status={status} /> : null}
      metrics={[fmtDuration(activity.durationMs)]}
    />
  )
}

export function opLogActivityTreeRowHeight(): number {
  return 40
}
