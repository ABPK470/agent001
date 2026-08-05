/**
 * Expandable text in Trace — line peek with footer More/Less.
 * Sticky section headers own their own controls (see TraceContextDetail);
 * this module never floats a sticky rail over prose.
 */

import { ChevronDown, ChevronRight } from "lucide-react"
import { useEffect, useRef, useState, type Ref } from "react"
import { buildPeekDisplay } from "../../components/InlinePeekText"
import { preserveScrollAnchor } from "../../lib/chatScroll"
import { CopyControl } from "./TraceCopy"

const HEAD_LINES = 12
const TAIL_LINES = 4

export function useTextPeek(
  text: string,
  headLines = HEAD_LINES,
  tailLines = TAIL_LINES,
) {
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    setExpanded(false)
  }, [text])

  const { body, hiddenLines } = buildPeekDisplay(
    text,
    headLines,
    tailLines,
    expanded,
  )

  return {
    body,
    hiddenLines,
    expanded,
    setExpanded,
    hasPeek: hiddenLines > 0,
  }
}

export function PeekToggle({
  expanded,
  onToggle,
  toggleRef,
  className = "trace-expand__toggle",
}: {
  expanded: boolean
  onToggle: () => void
  toggleRef?: Ref<HTMLButtonElement>
  className?: string
}) {
  return (
    <button
      ref={toggleRef}
      type="button"
      className={className}
      aria-expanded={expanded}
      aria-label={expanded ? "Show less" : "Show more"}
      onClick={onToggle}
    >
      {expanded ? (
        <ChevronDown size={14} strokeWidth={2} aria-hidden />
      ) : (
        <ChevronRight size={14} strokeWidth={2} aria-hidden />
      )}
      <span>{expanded ? "Less" : "More"}</span>
    </button>
  )
}

/** Always applied — wrap lives on the component, not on caller class names. */
export const TRACE_EXPAND_PRE_CLASS = "trace-expand__pre"

export function ExpandableText({
  text,
  className,
  copyLabel,
}: {
  text: string
  className: string
  /** @deprecated Char preview — line peek is always used now. */
  previewChars?: number
  /** When set, show Copy in the footer controls. */
  copyLabel?: string
}) {
  const peek = useTextPeek(text)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const hasControls = peek.hasPeek || Boolean(copyLabel)

  function onTogglePeek() {
    preserveScrollAnchor(toggleRef.current, () =>
      peek.setExpanded((value) => !value),
    )
  }

  const main = (
    <pre
      className={[
        TRACE_EXPAND_PRE_CLASS,
        className,
        peek.hasPeek && !peek.expanded ? "is-peeking" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {peek.body}
    </pre>
  )

  if (!hasControls) return main

  return (
    <div
      className={`trace-expand${peek.hasPeek && !peek.expanded ? " is-clipped" : ""}`}
    >
      <div className="trace-expand__main">{main}</div>
      <div className="trace-expand__footer">
        {copyLabel ? <CopyControl value={text} ariaLabel={copyLabel} /> : null}
        {peek.hasPeek ? (
          <PeekToggle
            expanded={peek.expanded}
            onToggle={onTogglePeek}
            toggleRef={toggleRef}
          />
        ) : null}
      </div>
    </div>
  )
}
