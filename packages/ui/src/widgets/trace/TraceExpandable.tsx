/**
 * Expandable text — sticky right-rail Copy + More/Less (Context dialect).
 * Same control for Call / Sent / Received bodies.
 *
 * Collapsing reveals the block under the pin stack (no jump to later calls).
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
  /** When set, show Copy in the sticky rail. */
  copyLabel?: string
}) {
  const [expanded, setExpanded] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const isLong = text.length > previewChars

  useEffect(() => {
    setExpanded(false)
  }, [text])

  const display = !isLong || expanded ? text : `${text.slice(0, previewChars)}…`
  const showRail = Boolean(copyLabel) || isLong

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
      className={`trace-expand${showRail ? " has-rail" : ""}${isLong && !expanded ? " is-clipped" : ""}`}
    >
      <div className="trace-expand__main">
        <pre className={className}>{display}</pre>
      </div>
      {showRail && (
        <div className="trace-expand__rail">
          <div className="trace-expand__sticky">
            {copyLabel && (
              <CopyControl value={text} ariaLabel={copyLabel} />
            )}
            {isLong && (
              <ExpandToggle expanded={expanded} onToggle={onToggleExpand} />
            )}
          </div>
        </div>
      )}
    </div>
  )
}
