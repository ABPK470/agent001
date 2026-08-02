/**
 * Truncated description with explicit ellipsis + click to expand full text.
 */

import { useLayoutEffect, useRef, useState } from "react"

export function ExpandableDescription({
  text,
  className = "text-sm text-text-muted leading-snug",
}: {
  text: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const lineRef = useRef<HTMLParagraphElement>(null)
  const [overflows, setOverflows] = useState(false)

  useLayoutEffect(() => {
    setOpen(false)
  }, [text])

  useLayoutEffect(() => {
    const el = lineRef.current
    if (!el || open) return
    setOverflows(el.scrollWidth > el.clientWidth + 1)
  }, [text, open])

  if (!text) return null

  if (open) {
    return (
      <div className="min-w-0">
        <p className={`${className} whitespace-pre-wrap break-words`}>{text}</p>
        <button
          type="button"
          className="mt-1 text-xs text-text-faint transition-colors hover:text-text"
          onClick={() => setOpen(false)}
        >
          Show less
        </button>
      </div>
    )
  }

  return (
    <div className="min-w-0">
      <p
        ref={lineRef}
        className={`${className} truncate`}
      >
        {text}
      </p>
      {overflows ? (
        <button
          type="button"
          className="mt-0.5 text-xs text-text-faint transition-colors hover:text-text"
          onClick={() => setOpen(true)}
        >
          Show full description
        </button>
      ) : null}
    </div>
  )
}
