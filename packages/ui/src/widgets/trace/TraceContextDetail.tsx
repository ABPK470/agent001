/**
 * Context / prompt / tools detail for preamble nodes.
 */

import { JsonViewer } from "../../components/JsonViewer"
import type { TraceDag } from "./build-trace-dag"
import { CopyControl } from "./TraceCopy"
import { TraceDetailCollapsible } from "./TraceDetailCollapsible"
import { ExpandableText } from "./TraceExpandable"
import { ToolDef } from "./TraceRows"

function lineCount(text: string): number {
  if (!text) return 0
  return text.replace(/\r\n/g, "\n").split("\n").length
}

function promptMeta(text: string): string {
  const lines = lineCount(text)
  return lines === 1 ? "1 line" : `${lines} lines`
}

function toolMeta(tool: TraceDag["preamble"]["tools"][number]): string | undefined {
  if (!tool.description) return "no description"
  const words = tool.description.trim().split(/\s+/).length
  return words === 1 ? "1 word" : `${words} words`
}

function ContextPromptBody({ text }: { text: string }) {
  return (
    <div className="trace-detail-prose">
      <ExpandableText text={text} className="trace-body-muted" />
    </div>
  )
}

function ContextToolsBody({
  tools,
}: {
  tools: TraceDag["preamble"]["tools"]
}) {
  if (tools.length === 0) {
    return <p className="trace-empty">No tools resolved</p>
  }

  if (tools.length === 1) {
    const tool = tools[0]!
    return (
      <div className="trace-detail-tool-pane">
        <ToolDef tool={tool} />
        {tool.parameters ? (
          <JsonViewer
            value={tool.parameters}
            copyable
            embedded
            label="schema"
            defaultExpandDepth={1}
          />
        ) : null}
      </div>
    )
  }

  return (
    <div className="trace-detail-collapsible-list">
      {tools.map((tool) => (
        <TraceDetailCollapsible
          key={tool.name}
          label={tool.name}
          meta={toolMeta(tool)}
          defaultOpen={false}
          sticky={false}
          variant="nested"
        >
          <div className="trace-detail-tool-pane">
            <ToolDef tool={tool} hideName />
            {tool.parameters ? (
              <JsonViewer
                value={tool.parameters}
                copyable
                embedded
                label="schema"
                defaultExpandDepth={1}
              />
            ) : null}
          </div>
        </TraceDetailCollapsible>
      ))}
    </div>
  )
}

export function TraceContextDetail({
  dag,
  scopeId,
}: {
  dag: TraceDag
  scopeId: "context" | "prompt" | "tools"
}) {
  const { preamble } = dag

  if (scopeId === "prompt" && preamble.systemPrompt) {
    return (
      <div className="trace-detail-body trace-detail-body--stack">
        <TraceDetailCollapsible
          label="System prompt"
          meta={promptMeta(preamble.systemPrompt)}
          defaultOpen
          actions={
            <CopyControl value={preamble.systemPrompt} ariaLabel="Copy system prompt" />
          }
        >
          <ContextPromptBody text={preamble.systemPrompt} />
        </TraceDetailCollapsible>
      </div>
    )
  }

  if (scopeId === "tools") {
    return (
      <div className="trace-detail-body trace-detail-body--stack">
        <TraceDetailCollapsible
          label="Resolved tools"
          meta={String(preamble.tools.length)}
          defaultOpen
        >
          <ContextToolsBody tools={preamble.tools} />
        </TraceDetailCollapsible>
      </div>
    )
  }

  return (
    <div className="trace-detail-body trace-detail-body--stack">
      {preamble.systemPrompt ? (
        <TraceDetailCollapsible
          label="System prompt"
          meta={promptMeta(preamble.systemPrompt)}
          defaultOpen
          actions={
            <CopyControl value={preamble.systemPrompt} ariaLabel="Copy system prompt" />
          }
        >
          <ContextPromptBody text={preamble.systemPrompt} />
        </TraceDetailCollapsible>
      ) : null}
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
