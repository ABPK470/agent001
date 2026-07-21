/**
 * Long text with a sticky action bar — Copy and More/Less share the
 * same control dialect (icon + label) and stick together while scrolling.
 */

import { ChevronsDown, ChevronsUp } from "lucide-react"
import { useEffect, useState } from "react"
import { CopyControl } from "./TraceCopy"

export function ExpandableText({
  text,
  className,
  previewChars = 280,
  copyLabel,
}: {
  text: string
  className: string
  previewChars?: number
  /** When set, show a Copy control in the sticky action bar. */
  copyLabel?: string
}) {
  const [expanded, setExpanded] = useState(false)
  const isLong = text.length > previewChars

  useEffect(() => {
    setExpanded(false)
  }, [text])

  const display = !isLong || expanded ? text : `${text.slice(0, previewChars)}…`
  const showActions = Boolean(copyLabel) || isLong

  function onToggleExpand() {
    setExpanded((v) => !v)
  }

  return (
    <div
      className={`trace-expand${isLong && !expanded ? " is-clipped" : ""}`}
    >
      {showActions && (
        <div className="trace-expand__actions">
          {copyLabel && (
            <CopyControl value={text} ariaLabel={copyLabel} />
          )}
          {isLong && (
            <button
              type="button"
              className="trace-copy"
              onClick={onToggleExpand}
              aria-expanded={expanded}
              aria-label={expanded ? "Show less" : "Show more"}
              title={expanded ? "Show less" : "Show more"}
            >
              {expanded ? <ChevronsUp size={11} /> : <ChevronsDown size={11} />}
              <span>{expanded ? "Less" : "More"}</span>
            </button>
          )}
        </div>
      )}
      <div className="trace-expand__main">
        <pre className={className}>{display}</pre>
      </div>
    </div>
  )
}
