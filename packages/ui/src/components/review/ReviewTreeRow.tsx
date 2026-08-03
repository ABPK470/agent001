import { ChevronRight } from "lucide-react"
import type { CSSProperties, MouseEvent, ReactNode } from "react"
import { reviewTreeNodeCellStyle } from "./review-tree-geometry"

export function ReviewTreeRow({
  depth,
  selected,
  hasChildren,
  folded,
  hasSubtitle,
  isRoot,
  rowClassName = "",
  btnClassName = "",
  nodeCellClassName = "",
  gridTemplateColumns,
  onSelect,
  onToggleFold,
  icon,
  title,
  subtitle,
  trailing,
  metrics,
}: {
  depth: number
  selected: boolean
  hasChildren: boolean
  folded: boolean
  hasSubtitle?: boolean
  isRoot?: boolean
  rowClassName?: string
  btnClassName?: string
  nodeCellClassName?: string
  gridTemplateColumns?: string
  onSelect: () => void
  onToggleFold?: () => void
  icon?: ReactNode
  title: ReactNode
  subtitle?: ReactNode
  trailing?: ReactNode
  metrics?: ReactNode[]
}) {
  function onChevronClick(event: MouseEvent<HTMLSpanElement>) {
    event.stopPropagation()
    if (hasChildren && onToggleFold) onToggleFold()
  }

  const btnStyle: CSSProperties | undefined = gridTemplateColumns
    ? { gridTemplateColumns }
    : undefined

  return (
    <div
      className={[
        "review-tree-row",
        rowClassName,
        selected ? "is-selected" : "",
        hasSubtitle ? "has-subtitle" : "",
        hasChildren ? "is-branch" : "is-leaf",
        isRoot ?? depth === 0 ? "is-root" : "is-child",
      ]
        .filter(Boolean)
        .join(" ")}
      role="treeitem"
      aria-selected={selected}
      aria-expanded={hasChildren ? !folded : undefined}
    >
      <button
        type="button"
        className={["review-tree-row__btn", btnClassName].filter(Boolean).join(" ")}
        style={btnStyle}
        onClick={onSelect}
      >
        <span
          className={["review-tree-row__node-cell", nodeCellClassName].filter(Boolean).join(" ")}
          style={reviewTreeNodeCellStyle(depth)}
        >
          <span className="review-tree-row__chev" onClick={onChevronClick} aria-hidden>
            {hasChildren ? (
              <ChevronRight
                size={13}
                className={`review-tree-row__chev-icon${folded ? "" : " is-open"}`}
              />
            ) : null}
          </span>
          {icon ? (
            <span className="review-tree-row__icon" aria-hidden>
              {icon}
            </span>
          ) : null}
          <span className="review-tree-row__text-block min-w-0 flex-1">
            <span className="review-tree-row__title-stack">
              <span className="review-tree-row__name truncate">{title}</span>
              {subtitle ? (
                <span className="review-tree-row__subtitle">{subtitle}</span>
              ) : null}
            </span>
          </span>
          {trailing}
        </span>
        {metrics?.map((metric, index) => (
          <span key={index} className="review-tree-row__metric tabular-nums">
            {metric}
          </span>
        ))}
      </button>
    </div>
  )
}
