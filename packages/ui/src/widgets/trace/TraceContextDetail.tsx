/**
 * Context / prompt / tools detail for preamble nodes.
 */

import { JsonViewer } from "../../components/JsonViewer"
import type { TraceDag } from "./build-trace-dag"
import { ExpandableText } from "./TraceExpandable"
import { ToolDef } from "./TraceRows"

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
      <div className="trace-detail-body">
        <ExpandableText text={preamble.systemPrompt} className="trace-body-muted" />
      </div>
    )
  }

  if (scopeId === "tools") {
    return (
      <div className="trace-detail-body">
        {preamble.tools.length === 0 ? (
          <p className="trace-empty">No tools resolved</p>
        ) : (
          preamble.tools.map((tool) => (
            <div key={tool.name} className="trace-detail-section">
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
          ))
        )}
      </div>
    )
  }

  return (
    <div className="trace-detail-body">
      {preamble.systemPrompt ? (
        <section className="trace-detail-section">
          <div className="trace-detail-section__label">System prompt</div>
          <ExpandableText text={preamble.systemPrompt} className="trace-body-muted" />
        </section>
      ) : null}
      {preamble.tools.length > 0 ? (
        <section className="trace-detail-section">
          <div className="trace-detail-section__label">
            Tools ({preamble.tools.length})
          </div>
          {preamble.tools.map((tool) => (
            <ToolDef key={tool.name} tool={tool} />
          ))}
        </section>
      ) : null}
    </div>
  )
}
