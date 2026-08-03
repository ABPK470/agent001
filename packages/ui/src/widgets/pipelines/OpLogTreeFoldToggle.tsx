/**
 * Left-tree expand/collapse all — SegmentToggle in the split-list cap.
 */

import type { JSX } from "react"
import { SegmentToggle } from "../entity-registry/SegmentToggle"
import type { OpLogTreeFoldMode } from "./op-log-tree-open-state"

export function OpLogTreeFoldToggle({
  foldMode,
  onFoldModeChange,
}: {
  foldMode: OpLogTreeFoldMode
  onFoldModeChange: (mode: OpLogTreeFoldMode) => void
}): JSX.Element {
  return (
    <SegmentToggle
      value={foldMode}
      options={[
        { value: "expanded", label: "Expanded" },
        { value: "collapsed", label: "Collapsed" },
      ]}
      onChange={onFoldModeChange}
      ariaLabel="Expand or collapse all pipelines in the tree"
    />
  )
}
