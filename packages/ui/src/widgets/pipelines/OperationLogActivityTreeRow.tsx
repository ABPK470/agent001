/**
 * Left-tree activity row — select drives the right detail pane; chevron folds children.
 */

import { ChevronRight } from "lucide-react"
import type { OperationActivity, OperationKind, OperationStatus } from "../../client/index"
import { traceTreeNodeCellStyle } from "../trace/trace-tree-guides"
import { activityEntityIcon } from "./op-log-entity-icon"
import { OpLogEntityIcon } from "./OpLogEntityIcon"
import { OpLogStatusPill } from "./OpLogStatusPill"
import { OP_LOG, OP_LOG_DESC, OP_LOG_MUTED, fmtDuration } from "./operation-log-row"
import { opLogShowStatusPill } from "./op-log-row-policy"

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
    <div
      className={[
        "trace-tree-row op-log-activity-tree-row",
        selected ? "is-selected" : "",
        hasChildren ? "is-branch" : "is-leaf",
        depth > 0 ? "is-child" : "is-root",
      ]
        .filter(Boolean)
        .join(" ")}
      role="treeitem"
      aria-selected={selected}
      aria-expanded={hasChildren ? !folded : undefined}
    >
      <button
        type="button"
        className="trace-tree-row__btn op-log-activity-tree-row__btn"
        onClick={onSelect}
      >
        <span
          className="trace-tree-row__node-cell op-log-activity-tree-row__node-cell"
          style={traceTreeNodeCellStyle(depth)}
        >
          <span
            className="trace-tree-row__chev"
            onClick={(event) => {
              event.stopPropagation()
              if (hasChildren) onToggleFold()
            }}
            aria-hidden
          >
            {hasChildren ? (
              <ChevronRight
                size={13}
                className={`trace-tree-row__chev-icon${folded ? "" : " is-open"}`}
              />
            ) : null}
          </span>
          <span className="trace-tree-row__icon" aria-hidden>
            <OpLogEntityIcon icon={entity.Icon} color={entity.color} />
          </span>
          <span className="trace-tree-row__text-block min-w-0 flex-1">
            <span className="trace-tree-row__title-stack">
              <span className={`trace-tree-row__name truncate ${OP_LOG}`} title={label}>
                {label}
                {summary ? (
                  <>
                    <span className={OP_LOG_DESC}> · </span>
                    <span className={`${OP_LOG_DESC} font-normal`}>{summary}</span>
                  </>
                ) : null}
              </span>
            </span>
          </span>
          <span className={`op-log-activity-tree-row__duration review-meta ${OP_LOG_MUTED}`}>
            {fmtDuration(activity.durationMs)}
          </span>
          {showPill ? <OpLogStatusPill status={status} /> : null}
        </span>
      </button>
    </div>
  )
}

export function opLogActivityTreeRowHeight(): number {
  return 40
}
