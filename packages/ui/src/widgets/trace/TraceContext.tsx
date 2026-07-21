/**
 * Shared Context card — Prompt / Tools as real outline scopes (sticky + indent).
 */

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
        depth={1}
        open={open}
        onToggle={onToggle}
        leading="Context"
        summary={bits.join(" · ") || "empty"}
        soft
      />
      {open && (
        <div className="trace-card__body trace-nest">
          {preamble.systemPrompt && promptMatches && (
            <>
              <ScopeRow
                scopeId="prompt"
                kind="prompt"
                depth={2}
                open={contextPromptOpen}
                onToggle={onTogglePrompt}
                leading="Prompt"
                summary={`${formatCharCount(preamble.systemPrompt.length)} chars`}
                soft
              />
              {contextPromptOpen && (
                <div className="trace-scope-body">
                  <ExpandableText
                    text={preamble.systemPrompt}
                    className="trace-body-muted"
                    previewChars={720}
                    copyLabel="Copy prompt"
                  />
                </div>
              )}
            </>
          )}
          {tools.length > 0 && (
            <>
              <ScopeRow
                scopeId="tools"
                kind="tools"
                depth={2}
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
                <div className="trace-scope-body">
                  {tools.map((t) => (
                    <ToolDef key={t.name} tool={t} />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </article>
  )
}
