/**
 * Left-tree activity row — select drives the right detail pane; chevron folds children.
 * Trace dialect: title over muted subtitle, whitespace depth indent (no ├└ hairlines).
 * Glyph: top-level phases = functional icon + status badge; nested/leaf = status dot.
 */

import type { OperationActivity, OperationStatus } from "../../client/index"
import { ReviewTreeRow } from "../../components/review"
import { resolveActivityTreeVisual } from "./op-log-entity-icon"
import { OpLogEntityIcon } from "./OpLogEntityIcon"
import { OpLogStatusDot } from "./OpLogStatusDot"
import { OpLogStatusPill } from "./OpLogStatusPill"
import { fmtDuration } from "./operation-log-row"
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
  onSelect: () => void
  onToggleFold: () => void
}) {
  // Leaves / nested steps: status dot only for OK; FAIL/Running keep the pill.
  const showPill = opLogShowStatusPill({ status, leaf: !hasChildren })
  const visual = resolveActivityTreeVisual({ activity, hasChildren, status, depth })
  const hasSubtitle = Boolean(summary?.trim())
  const icon =
    visual.type === "icon" ? (
      <>
        <OpLogEntityIcon icon={visual.Icon} color={visual.color} />
        <OpLogStatusDot status={visual.status} badge />
      </>
    ) : (
      <OpLogStatusDot status={visual.status} />
    )

  return (
    <ReviewTreeRow
      depth={depth}
      selected={selected}
      hasChildren={hasChildren}
      folded={folded}
      hasSubtitle={hasSubtitle}
      isRoot={depth === 0}
      rowClassName="op-log-activity-tree-row"
      gridTemplateColumns={REVIEW_TREE_GRID_COLS}
      onSelect={onSelect}
      onToggleFold={onToggleFold}
      icon={icon}
      title={<span title={label}>{label}</span>}
      subtitle={
        hasSubtitle ? <span title={summary}>{summary}</span> : undefined
      }
      trailing={showPill ? <OpLogStatusPill status={status} /> : null}
      metrics={[fmtDuration(activity.durationMs)]}
    />
  )
}

export function opLogActivityTreeRowHeight(summary?: string | null): number {
  return summary?.trim() ? 54 : 40
}
