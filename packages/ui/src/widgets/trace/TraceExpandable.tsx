/**
 * Long text with a sticky right-rail More/Less control.
 * Uses the same bordered icon button as Entity Registry sidebar actions.
 */

import { ChevronsDown, ChevronsUp } from "lucide-react"
import { useEffect, useState } from "react"
import {
  IconButton,
  TOOLBAR_ICON,
} from "../entity-registry/IconButton"
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

  const label = expanded
    ? "Show less"
    : `Show more · ${formatCharCount(text.length)} chars`

  return (
    <div
      className={`trace-expand${isLong ? " has-rail" : ""}${isLong && !expanded ? " is-clipped" : ""}`}
    >
      <div className="trace-expand__main">
        <pre className={className}>{display}</pre>
      </div>
      {isLong && (
        <div className="trace-expand__rail">
          <div className="trace-expand__sticky">
            <IconButton
              label={label}
              active={expanded}
              onClick={onToggleExpand}
              aria-expanded={expanded}
            >
              {expanded ? (
                <ChevronsUp {...TOOLBAR_ICON} />
              ) : (
                <ChevronsDown {...TOOLBAR_ICON} />
              )}
            </IconButton>
          </div>
        </div>
      )}
    </div>
  )
}
