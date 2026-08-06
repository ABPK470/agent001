/**
 * System prompt blocks — one dialect for Context, Prompt leaf, and Call System.
 *
 * Sticky section header owns Copy + More/Less; body is monospace source text.
 */

import { useRef } from "react"
import { preserveScrollAnchor } from "../../lib/chatScroll"
import { CopyControl } from "./TraceCopy"
import { TraceDetailCollapsible } from "./TraceDetailCollapsible"
import { PeekToggle, useTextPeek } from "./TraceExpandable"

function lineCount(text: string): number {
  if (!text) return 0
  return text.replace(/\r\n/g, "\n").split("\n").length
}

export function promptLineMeta(text: string): string {
  const lines = lineCount(text)
  return lines === 1 ? "1 line" : `${lines} lines`
}

function PromptBody({ body, clipped }: { body: string; clipped: boolean }) {
  return (
    <div className={`trace-detail-prose trace-detail-prose--mono${clipped ? " is-clipped" : ""}`}>
      <pre className={`trace-system-prompt${clipped ? " is-peeking" : ""}`.trim()}>
        {body}
      </pre>
    </div>
  )
}

export function SystemPromptSection({
  text,
  label,
  defaultOpen = true,
}: {
  text: string
  label: string
  defaultOpen?: boolean
}) {
  const peek = useTextPeek(text)
  const toggleRef = useRef<HTMLButtonElement>(null)

  function onTogglePeek() {
    preserveScrollAnchor(toggleRef.current, () =>
      peek.setExpanded((value) => !value),
    )
  }

  return (
    <TraceDetailCollapsible
      label={label}
      meta={promptLineMeta(text)}
      defaultOpen={defaultOpen}
      peek={
        peek.hasPeek
          ? {
              hasPeek: true,
              expanded: peek.expanded,
              setExpanded: (next) => peek.setExpanded(next),
            }
          : null
      }
      actions={({ open }) => (
        <>
          <CopyControl value={text} ariaLabel="Copy system prompt" />
          {open && peek.hasPeek ? (
            <PeekToggle
              expanded={peek.expanded}
              onToggle={onTogglePeek}
              toggleRef={toggleRef}
              className="trace-detail-accordion__peek"
            />
          ) : null}
        </>
      )}
    >
      <PromptBody body={peek.body} clipped={peek.hasPeek && !peek.expanded} />
    </TraceDetailCollapsible>
  )
}

export function SystemPromptStack({
  prompts,
  labelFor,
  defaultOpenFirst = true,
}: {
  prompts: string[]
  labelFor: (index: number, total: number) => string
  defaultOpenFirst?: boolean
}) {
  if (prompts.length === 0) {
    return <p className="trace-empty">No system prompt</p>
  }

  return (
    <div className="trace-detail-body--stack">
      {prompts.map((text, i) => (
        <SystemPromptSection
          key={`prompt-${i}`}
          text={text}
          label={labelFor(i, prompts.length)}
          defaultOpen={defaultOpenFirst ? i === 0 : false}
        />
      ))}
    </div>
  )
}
