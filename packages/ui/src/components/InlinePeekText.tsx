/**
 * Inline peek for long monospace payloads — head/tail preview, expand to full
 * height in the transcript (one scrollport; no nested scrollbar).
 */

import { useEffect, useRef, useState } from "react"
import { preserveScrollAnchor } from "../lib/chatScroll"

const DEFAULT_HEAD_LINES = 12
const DEFAULT_TAIL_LINES = 4

function normalizeLines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").split("\n")
}

export function countHiddenPeekLines(
  lineCount: number,
  headLines: number,
  tailLines: number,
): number {
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
    return { body: text, hiddenLines: 0, totalLines }
  }
  const head = lines.slice(0, headLines).join("\n")
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

  useEffect(() => {
    setExpanded(false)
  }, [text])

  const { body, hiddenLines, totalLines } = buildPeekDisplay(
    text,
    headLines,
    tailLines,
    expanded,
  )

  return (
    <div className="min-w-0 space-y-1.5">
      <pre className={className ?? "code-pre m-0 w-full max-w-full whitespace-pre-wrap break-words px-0.5 text-[15px] leading-5 text-text-muted"}>
        {body}
      </pre>
      {hiddenLines > 0 ? (
        <button
          ref={toggleRef}
          type="button"
          className="text-[13px] text-text-muted transition-colors hover:text-text"
          onClick={() => {
            preserveScrollAnchor(toggleRef.current, () => setExpanded((value) => !value))
          }}
          aria-expanded={expanded}
        >
          {expanded ? "Show less" : `Expand full output (${totalLines} lines)`}
        </button>
      ) : null}
    </div>
  )
}
