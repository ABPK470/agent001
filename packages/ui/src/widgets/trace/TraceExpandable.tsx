/**
 * Expandable text — sticky right-rail Copy + More/Less.
 * Toggle only changes open state — scroll position is left alone.
 */

import { ListChevronsDownUp, ListChevronsUpDown } from "lucide-react"
import { useEffect, useState } from "react"
import { CopyControl } from "./TraceCopy"

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
      {expanded ? (
        <ListChevronsDownUp size={14} strokeWidth={1.75} />
      ) : (
        <ListChevronsUpDown size={14} strokeWidth={1.75} />
      )}
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
  const isLong = text.length > previewChars

  useEffect(() => {
    setExpanded(false)
  }, [text])

  const display = !isLong || expanded ? text : `${text.slice(0, previewChars)}…`
  const showRail = Boolean(copyLabel) || isLong

  function onToggleExpand() {
    setExpanded((v) => !v)
  }

  return (
    <div
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
