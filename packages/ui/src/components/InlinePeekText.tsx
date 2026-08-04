/**
 * Inline peek for long monospace payloads — first N lines, then Show more/less.
 * One scrollport (transcript owns scroll); no nested scrollbar.
 */

import { useEffect, useRef, useState } from "react"
import { useChatScroll } from "./ChatScrollContext"

/** Tool read/write dialect — first screenful, expand for the rest. */
const DEFAULT_HEAD_LINES = 10
/** 0 = head-only (preferred). Head+tail kept for callers that pass a positive tail. */
const DEFAULT_TAIL_LINES = 0

function normalizeLines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").split("\n")
}

export function countHiddenPeekLines(
  lineCount: number,
  headLines: number,
  tailLines: number,
): number {
  if (tailLines <= 0) {
    return lineCount > headLines ? lineCount - headLines : 0
  }
  if (lineCount <= headLines + tailLines + 1) return 0
  return lineCount - headLines - tailLines
}

export function buildPeekDisplay(
  text: string,
  headLines: number,
  tailLines: number,
  expanded: boolean,
): { body: string; hiddenLines: number; totalLines: number } {
  const lines = normalizeLines(text)
  const totalLines = lines.length
  const hiddenLines = countHiddenPeekLines(totalLines, headLines, tailLines)
  if (hiddenLines === 0 || expanded) {
    return { body: text, hiddenLines, totalLines }
  }
  const head = lines.slice(0, headLines).join("\n")
  if (tailLines <= 0) {
    return { body: head, hiddenLines, totalLines }
  }
  const tail = lines.slice(-tailLines).join("\n")
  return {
    body: `${head}\n… (${hiddenLines} lines hidden) …\n${tail}`,
    hiddenLines,
    totalLines,
  }
}

export function InlinePeekText({
  text,
  className,
  headLines = DEFAULT_HEAD_LINES,
  tailLines = DEFAULT_TAIL_LINES,
}: {
  text: string
  className?: string
  headLines?: number
  tailLines?: number
}) {
  const [expanded, setExpanded] = useState(false)
  const toggleRef = useRef<HTMLButtonElement>(null)
  // Pause host stick-to-bottom when expanding peeks during a live run.
  const { preserveToggle } = useChatScroll()

  useEffect(() => {
    setExpanded(false)
  }, [text])

  const totalLines = normalizeLines(text).length
  const collapsedHidden = countHiddenPeekLines(totalLines, headLines, tailLines)
  const { body } = buildPeekDisplay(text, headLines, tailLines, expanded)

  return (
    <div className="inline-peek min-w-0 space-y-1.5">
      <pre className={className ?? "code-pre m-0 w-full max-w-full whitespace-pre-wrap break-words px-0.5 text-[15px] leading-5 text-text-muted"}>
        {body}
      </pre>
      {collapsedHidden > 0 ? (
        <button
          ref={toggleRef}
          type="button"
          className="text-[13px] text-text-muted transition-colors hover:text-text"
          onClick={() => {
            preserveToggle(toggleRef.current, () => setExpanded((value) => !value))
          }}
          aria-expanded={expanded}
        >
          {expanded
            ? "Show less"
            : `Show more (${collapsedHidden} line${collapsedHidden === 1 ? "" : "s"})`}
        </button>
      ) : null}
    </div>
  )
}
