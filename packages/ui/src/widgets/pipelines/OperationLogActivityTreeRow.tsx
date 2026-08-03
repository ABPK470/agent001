/**
 * Left-tree activity row — select drives the right detail pane; chevron folds children.
 */

import type { OperationActivity, OperationKind, OperationStatus } from "../../client/index"
import { ReviewTreeRow } from "../../components/review"
import { activityEntityIcon } from "./op-log-entity-icon"
import { OpLogEntityIcon } from "./OpLogEntityIcon"
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
  pipelineKind,
  effectiveKind,
  selected,
  hasChildren,
  folded,
  onSelect,
  onToggleFold,
}: {
  activity: OperationActivity
  label: string
  summary?: string
  status: OperationStatus
  depth: number
  pipelineKind: OperationKind
  effectiveKind: OperationKind
  selected: boolean
  hasChildren: boolean
  folded: boolean
  onSelect: () => void
  onToggleFold: () => void
}) {
  const showPill = opLogShowStatusPill({ status })
  const entity = activityEntityIcon(pipelineKind, effectiveKind, activity)

  return (
    <ReviewTreeRow
      depth={depth}
      selected={selected}
      hasChildren={hasChildren}
      folded={folded}
      isRoot={depth === 0}
      rowClassName="op-log-activity-tree-row"
      gridTemplateColumns={REVIEW_TREE_GRID_COLS}
      onSelect={onSelect}
      onToggleFold={onToggleFold}
      icon={<OpLogEntityIcon icon={entity.Icon} color={entity.color} />}
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
