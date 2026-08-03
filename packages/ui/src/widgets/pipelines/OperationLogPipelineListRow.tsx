import type { OperationPipeline } from "../../client/index"
import { ReviewTreeRow } from "../../components/review"
import { pipelineEntityIcon } from "./op-log-entity-icon"
import { OpLogEntityIcon } from "./OpLogEntityIcon"
import { OpLogStatusPill } from "./OpLogStatusPill"
import { formatPipelineSubtitle, OP_LOG } from "./operation-log-row"

const REVIEW_TREE_GRID_COLS = "minmax(0, 1fr) var(--review-tree-col-duration)"

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
    <ReviewTreeRow
      depth={0}
      selected={selected}
      hasChildren={hasChildren}
      folded={folded}
      hasSubtitle={Boolean(subtitle)}
      isRoot
      rowClassName="op-log-pipeline-list-row"
      gridTemplateColumns={REVIEW_TREE_GRID_COLS}
      onSelect={() => onSelect(pipeline.id)}
      onToggleFold={() => onToggleFold(pipeline.id)}
      icon={<OpLogEntityIcon icon={entity.Icon} color={entity.color} />}
      title={<span className={OP_LOG}>{pipeline.title}</span>}
      subtitle={subtitle}
      trailing={<OpLogStatusPill status={pipeline.status} />}
      metrics={["—"]}
    />
  )
}

export function opLogPipelineListRowHeight(pipeline: OperationPipeline): number {
  return pipeline.subtitle ? 54 : 44
}
