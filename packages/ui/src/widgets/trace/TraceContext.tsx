/**
 * Context outline — Prompt / Tools as ReviewTree peers under Context.
 * Prompt prose uses trace-scope-payload (label column) — never the nested
 * peer gutter (that is for Tools children with elbows).
 */

import { ReviewTree, ReviewTreeItem } from "../../components/ReviewTree"
import type { TraceDag } from "./build-trace-dag"
import { formatCharCount } from "./trace-format"
import { ExpandableText } from "./TraceExpandable"
import { ToolDef } from "./TraceRows"
import { ScopeRow } from "./TraceScope"

export function PreambleOutline({
  dag,
  open,
  contextPromptOpen,
  contextToolsOpen,
  onToggle,
  onTogglePrompt,
  onToggleTools,
  query,
}: {
  dag: TraceDag
  open: boolean
  contextPromptOpen: boolean
  contextToolsOpen: boolean
  onToggle: () => void
  onTogglePrompt: () => void
  onToggleTools: () => void
  query: string
}) {
  const { preamble } = dag
  if (!preamble.systemPrompt && preamble.tools.length === 0) {
    return null
  }

  const q = query.trim().toLowerCase()
  const promptMatches =
    !q || (preamble.systemPrompt?.toLowerCase().includes(q) ?? false)
  const tools = !q
    ? preamble.tools
    : preamble.tools.filter(
        (t) =>
          t.name.toLowerCase().includes(q) ||
          t.description.toLowerCase().includes(q),
      )

  const bits: string[] = []
  if (preamble.systemPrompt) bits.push("prompt")
  if (preamble.tools.length > 0) bits.push(`${preamble.tools.length} tools`)

  return (
    <article className={`trace-card${open ? " is-open" : ""}`}>
      <ScopeRow
        scopeId="context"
        kind="context"
        depth={0}
        open={open}
        onToggle={onToggle}
        leading="Context"
        summary={bits.join(" · ") || "empty"}
        soft
      />
      {open && (
        <ReviewTree className="trace-card__body">
          {preamble.systemPrompt && promptMatches && (
            <ReviewTreeItem>
              <ScopeRow
                scopeId="prompt"
                kind="prompt"
                depth={1}
                open={contextPromptOpen}
                onToggle={onTogglePrompt}
                leading="Prompt"
                summary={`${formatCharCount(preamble.systemPrompt.length)} chars`}
                soft
              />
              {contextPromptOpen && (
                <div className="trace-scope-payload">
                  <ExpandableText
                    text={preamble.systemPrompt}
                    className="trace-body-muted"
                    previewChars={720}
                    copyLabel="Copy prompt"
                  />
                </div>
              )}
            </ReviewTreeItem>
          )}
          {tools.length > 0 && (
            <ReviewTreeItem>
              <ScopeRow
                scopeId="tools"
                kind="tools"
                depth={1}
                open={contextToolsOpen}
                onToggle={onToggleTools}
                leading="Tools"
                summary={
                  q
                    ? `${tools.length} of ${preamble.tools.length}`
                    : String(preamble.tools.length)
                }
                soft
              />
              {contextToolsOpen && (
                <ReviewTree className="trace-branch">
                  {tools.map((t) => (
                    <ReviewTreeItem key={t.name}>
                      <ToolDef tool={t} />
                    </ReviewTreeItem>
                  ))}
                </ReviewTree>
              )}
            </ReviewTreeItem>
          )}
        </ReviewTree>
      )}
    </article>
  )
}
