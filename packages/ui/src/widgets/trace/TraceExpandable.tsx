/**
 * Long text with a sticky right-rail More/Less control.
 * The rail stays in view while you scroll the block — always reachable.
 */

import { useEffect, useState } from "react"
import { formatCharCount } from "./trace-format"

export function ExpandableText({
  text,
  className,
  previewChars = 280,
}: {
  text: string
  className: string
  previewChars?: number
}) {
  const [expanded, setExpanded] = useState(false)
  const isLong = text.length > previewChars

  useEffect(() => {
    setExpanded(false)
  }, [text])

  const display = !isLong || expanded ? text : `${text.slice(0, previewChars)}…`

  function onToggleExpand() {
    setExpanded((v) => !v)
  }

  return (
    <div
      className={`trace-expand${isLong ? " has-rail" : ""}${isLong && !expanded ? " is-clipped" : ""}`}
    >
      <div className="trace-expand__main">
        <pre className={className}>{display}</pre>
      </div>
      {isLong && (
        <div className="trace-expand__rail" aria-hidden={false}>
          <button
            type="button"
            className="trace-expand__btn"
            onClick={onToggleExpand}
            aria-expanded={expanded}
            title={
              expanded
                ? "Show less"
                : `Show more · ${formatCharCount(text.length)} chars`
            }
          >
            <span className="trace-expand__btn-label">
              {expanded ? "Less" : "More"}
            </span>
            {!expanded && (
              <span className="trace-expand__btn-meta">
                {formatCharCount(text.length)}
              </span>
            )}
          </button>
        </div>
      )}
    </div>
  )
}
