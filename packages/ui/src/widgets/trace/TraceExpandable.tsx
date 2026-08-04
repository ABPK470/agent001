/**
 * Expandable text in trace — line peek with sticky expand/collapse rail.
 */

import { useEffect, useRef, useState } from "react"
import { buildPeekDisplay } from "../../components/InlinePeekText"
import { preserveScrollAnchor } from "../../lib/chatScroll"
import { CopyControl } from "./TraceCopy"

const HEAD_LINES = 12
const TAIL_LINES = 4

export function ExpandableText({
  text,
  className,
  copyLabel,
}: {
  text: string
  className: string
  /** @deprecated Char preview — line peek is always used now. */
  previewChars?: number
  /** When set, show Copy in the sticky rail. */
  copyLabel?: string
}) {
  const [expanded, setExpanded] = useState(false)
  const toggleRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    setExpanded(false)
  }, [text])

  const { body, hiddenLines, totalLines } = buildPeekDisplay(
    text,
    HEAD_LINES,
    TAIL_LINES,
    expanded,
  )
  const hasPeek = hiddenLines > 0
  const hasRail = hasPeek || Boolean(copyLabel)

  const main = (
    <pre
      className={`${className ?? ""}${hasPeek && !expanded ? " is-peeking" : ""}`.trim()}
    >
      {body}
    </pre>
  )

  if (!hasRail) return main

  return (
    <div className={`trace-expand has-rail${hasPeek && !expanded ? " is-clipped" : ""}`}>
      <div className="trace-expand__main">{main}</div>
      <div className="trace-expand__rail">
        <div className="trace-expand__sticky">
          {copyLabel ? <CopyControl value={text} ariaLabel={copyLabel} /> : null}
          {hasPeek ? (
            <button
              ref={toggleRef}
              type="button"
              className="trace-expand__toggle"
              aria-expanded={expanded}
              onClick={() => {
                preserveScrollAnchor(toggleRef.current, () =>
                  setExpanded((value) => !value),
                )
              }}
            >
              {expanded ? "Collapse" : `Expand · ${totalLines} lines`}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
