/**
 * Expandable text — More/Less sits under the text it discloses.
 * Copy (when present) sticks at the top; Less joins it once expanded
 * so you can collapse without scrolling back to the end.
 *
 * Collapsing restores scroll so the block stays in view (does not jump
 * to later LLM calls after shrinking a long Context prompt).
 */

import { ChevronsDown, ChevronsUp } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { CopyControl } from "./TraceCopy"
import { beginCollapseReveal } from "./trace-scroll-anchor"

function ExpandToggle({
  expanded,
  onToggle,
}: {
  expanded: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      className="trace-copy"
      onClick={onToggle}
      aria-expanded={expanded}
      aria-label={expanded ? "Show less" : "Show more"}
      title={expanded ? "Show less" : "Show more"}
    >
      {expanded ? <ChevronsUp size={11} /> : <ChevronsDown size={11} />}
      <span>{expanded ? "Less" : "More"}</span>
    </button>
  )
}

export function ExpandableText({
  text,
  className,
  previewChars = 480,
  copyLabel,
}: {
  text: string
  className: string
  previewChars?: number
  /** When set, show a sticky Copy control above the text. */
  copyLabel?: string
}) {
  const [expanded, setExpanded] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const isLong = text.length > previewChars

  useEffect(() => {
    setExpanded(false)
  }, [text])

  const display = !isLong || expanded ? text : `${text.slice(0, previewChars)}…`
  const stickyLess = Boolean(copyLabel) && isLong && expanded
  const footToggle = isLong && !stickyLess

  function onToggleExpand() {
    if (expanded) {
      const root = rootRef.current
      const restore = root ? beginCollapseReveal(root) : () => {}
      setExpanded(false)
      restore()
      return
    }
    setExpanded(true)
  }

  return (
    <div
      ref={rootRef}
      className={`trace-expand${isLong && !expanded ? " is-clipped" : ""}`}
    >
      {copyLabel && (
        <div className="trace-expand__actions">
          <CopyControl value={text} ariaLabel={copyLabel} />
          {stickyLess && (
            <ExpandToggle expanded onToggle={onToggleExpand} />
          )}
        </div>
      )}
      <div className="trace-expand__main">
        <pre className={className}>{display}</pre>
      </div>
      {footToggle && (
        <div className="trace-expand__foot">
          <ExpandToggle expanded={expanded} onToggle={onToggleExpand} />
        </div>
      )}
    </div>
  )
}
