/**
 * Context / prompt / tools detail for preamble nodes.
 *
 * Leaf scopes (prompt / tools): inspector headline owns the title — body is content only.
 * Context scope: headline is "Context"; body uses collapsible sections.
 *
 * System prompts share TraceSystemPrompt (header Copy/More + mono body) with Call System.
 */

import { useRef } from "react"
import { preserveScrollAnchor } from "../../lib/chatScroll"
import type { TraceDag } from "./build-trace-dag"
import { CopyControl } from "./TraceCopy"
import { TraceDetailCollapsible } from "./TraceDetailCollapsible"
import { PeekToggle, useTextPeek } from "./TraceExpandable"
import {
  promptLineMeta,
  SystemPromptSection,
  SystemPromptStack,
} from "./TraceSystemPrompt"
import { ToolDef } from "./TraceRows"

function ContextToolsBody({
  tools,
}: {
  tools: TraceDag["preamble"]["tools"]
}) {
  if (tools.length === 0) {
    return <p className="trace-empty">No tools resolved</p>
  }

  if (tools.length === 1) {
    return (
      <div className="trace-detail-tool-pane">
        <ToolDef tool={tools[0]!} />
      </div>
    )
  }

  return (
    <div className="trace-detail-nested-list">
      {tools.map((tool) => (
        <TraceDetailCollapsible
          key={tool.name}
          label={tool.name}
          defaultOpen={false}
          sticky={false}
          variant="nested"
        >
          <div className="trace-detail-tool-pane">
            <ToolDef tool={tool} hideName />
          </div>
        </TraceDetailCollapsible>
      ))}
    </div>
  )
}

function PromptLeafDetail({ text }: { text: string }) {
  const peek = useTextPeek(text)
  const toggleRef = useRef<HTMLButtonElement>(null)

  function onTogglePeek() {
    preserveScrollAnchor(toggleRef.current, () =>
      peek.setExpanded((value) => !value),
    )
  }

  return (
    <div className="trace-detail-body">
      <div className="trace-detail-leaf-meta">
        <span className="trace-detail-leaf-meta__label">{promptLineMeta(text)}</span>
        <CopyControl value={text} ariaLabel="Copy system prompt" />
        {peek.hasPeek ? (
          <PeekToggle
            expanded={peek.expanded}
            onToggle={onTogglePeek}
            toggleRef={toggleRef}
            className="trace-detail-accordion__peek"
          />
        ) : null}
      </div>
      <div
        className={`trace-detail-prose trace-detail-prose--mono${peek.hasPeek && !peek.expanded ? " is-clipped" : ""}`}
      >
        <pre
          className={`trace-system-prompt${peek.hasPeek && !peek.expanded ? " is-peeking" : ""}`.trim()}
        >
          {peek.body}
        </pre>
      </div>
    </div>
  )
}

function promptLabel(index: number, total: number): string {
  return total > 1 ? `System prompt ${index + 1}` : "System prompt"
}

export function TraceContextDetail({
  dag,
  scopeId,
}: {
  dag: TraceDag
  scopeId: "context" | "prompt" | "tools"
}) {
  const { preamble } = dag

  const prompts =
    preamble.systemPrompts.length > 0
      ? preamble.systemPrompts
      : preamble.systemPrompt
        ? [preamble.systemPrompt]
        : []

  if (scopeId === "prompt" && prompts.length === 1) {
    return <PromptLeafDetail text={prompts[0]!} />
  }

  if (scopeId === "prompt" && prompts.length > 1) {
    return (
      <SystemPromptStack prompts={prompts} labelFor={promptLabel} />
    )
  }

  if (scopeId === "tools") {
    return (
      <div className="trace-detail-body">
        <ContextToolsBody tools={preamble.tools} />
      </div>
    )
  }

  return (
    <div className="trace-detail-body trace-detail-body--stack">
      {prompts.map((text, i) => (
        <SystemPromptSection
          key={`prompt-${i}`}
          text={text}
          label={promptLabel(i, prompts.length)}
          defaultOpen={i === 0}
        />
      ))}
      {preamble.tools.length > 0 ? (
        <TraceDetailCollapsible
          label="Resolved tools"
          meta={String(preamble.tools.length)}
          defaultOpen
        >
          <ContextToolsBody tools={preamble.tools} />
        </TraceDetailCollapsible>
      ) : null}
    </div>
  )
}
