import type { JSX } from "react"

export type ReviewTreeHeaderColumn = {
  id: string
  label: string
  align?: "left" | "right"
}

export function ReviewTreeHeader({
  columns,
  gridTemplateColumns,
}: {
  columns: ReviewTreeHeaderColumn[]
  gridTemplateColumns?: string
}): JSX.Element {
  const style = gridTemplateColumns ? { gridTemplateColumns } : undefined
  return (
    <div
      className="review-tree-header review-split-header-row review-split-header-row--secondary"
      style={style}
      aria-hidden
    >
      {columns.map((col) => (
        <span
          key={col.id}
          className={[
            col.id === "node" ? "review-tree-header__node" : "review-tree-header__metric",
            col.align === "right" ? "text-right" : "text-left",
          ]
            .filter(Boolean)
            .join(" ")}
        >
          {col.label}
        </span>
      ))}
    </div>
  )
}
