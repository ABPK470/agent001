import { ChevronRight } from "lucide-react"
import type { OperationPipeline } from "../../client/index"
import { pipelineEntityIcon } from "./op-log-entity-icon"
import { OpLogEntityIcon } from "./OpLogEntityIcon"
import { OpLogStatusPill } from "./OpLogStatusPill"
import { formatPipelineSubtitle, OP_LOG } from "./operation-log-row"

/** Left split-pane pipeline root — accent bar selection; chevron folds activity children. */
export function OperationLogPipelineListRow({
  pipeline,
  selected,
  hasChildren,
  folded,
  onSelect,
  onToggleFold,
}: {
  pipeline: OperationPipeline
  selected: boolean
  hasChildren: boolean
  folded: boolean
  onSelect: (id: string) => void
  onToggleFold: (id: string) => void
}) {
  const entity = pipelineEntityIcon(pipeline.kind)
  const subtitle = pipeline.subtitle ? formatPipelineSubtitle(pipeline.subtitle) : null

  return (
    <div
      className={[
        "trace-tree-row op-log-pipeline-list-row",
        selected ? "is-selected" : "",
        subtitle ? "has-subtitle" : "",
        hasChildren ? "is-branch" : "is-leaf",
        "is-root",
      ]
        .filter(Boolean)
        .join(" ")}
      role="treeitem"
      aria-selected={selected}
      aria-expanded={hasChildren ? !folded : undefined}
    >
      <button
        type="button"
        className="trace-tree-row__btn op-log-pipeline-list-row__btn"
        onClick={() => onSelect(pipeline.id)}
      >
        <span className="trace-tree-row__node-cell op-log-pipeline-list-row__node-cell">
          <span
            className="trace-tree-row__chev"
            onClick={(event) => {
              event.stopPropagation()
              if (hasChildren) onToggleFold(pipeline.id)
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
              <span className={`trace-tree-row__name truncate ${OP_LOG}`}>{pipeline.title}</span>
              {subtitle ? (
                <span className="trace-tree-row__subtitle op-log-pipeline-list-row__route" title={subtitle}>
                  {subtitle}
                </span>
              ) : null}
            </span>
          </span>
          <OpLogStatusPill status={pipeline.status} />
        </span>
      </button>
    </div>
  )
}

export function opLogPipelineListRowHeight(pipeline: OperationPipeline): number {
  return pipeline.subtitle ? 54 : 44
}
