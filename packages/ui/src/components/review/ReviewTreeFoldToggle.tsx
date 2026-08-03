import type { JSX } from "react"
import { SegmentToggle } from "../../widgets/entity-registry/SegmentToggle"
import type { ReviewTreeFoldMode } from "./review-tree-open-state"

export function ReviewTreeFoldToggle({
  foldMode,
  onFoldModeChange,
  ariaLabel = "Expand or collapse all tree scopes",
}: {
  foldMode: ReviewTreeFoldMode
  onFoldModeChange: (mode: ReviewTreeFoldMode) => void
  ariaLabel?: string
}): JSX.Element {
  return (
    <SegmentToggle
      value={foldMode}
      options={[
        { value: "expanded", label: "Expanded" },
        { value: "collapsed", label: "Collapsed" },
      ]}
      onChange={onFoldModeChange}
      ariaLabel={ariaLabel}
    />
  )
}
