/**
 * Shared Context card — system prompt + tool definitions.
 */

import { ChevronDown, ChevronRight } from "lucide-react"
import type { ReactNode } from "react"
import type { TraceDag } from "./build-trace-dag"
import { formatCharCount } from "./trace-format"
import { CopyControl } from "./TraceCopy"
import { ExpandableText } from "./TraceExpandable"
import { ToolDef } from "./TraceRows"
import { ScopeRow } from "./TraceScope"

function ContextFold({
  open,
  onToggle,
  label,
  detail,
  tone,
  children,
}: {
  open: boolean
  onToggle: () => void
  label: string
  detail?: string
  tone: "prompt" | "tools"
  children: ReactNode
}) {
  return (
    <div className={`trace-ctx-fold is-${tone}`}>
      <button
        type="button"
        className="trace-ctx-fold__btn"
        onClick={onToggle}
        aria-expanded={open}
      >
        <span className="trace-scope__chevslot" aria-hidden>
          {open ? (
            <ChevronDown size={14} className="trace-scope__chev" />
          ) : (
            <ChevronRight size={14} className="trace-scope__chev" />
          )}
        </span>
        <span className="trace-ctx-fold__label">{label}</span>
        {detail && <span className="trace-row__detail">{detail}</span>}
      </button>
      {open && <div className="trace-ctx-fold__body">{children}</div>}
    </div>
  )
}

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
        open={open}
        onToggle={onToggle}
        leading="Context"
        summary={bits.join(" · ") || "empty"}
        soft
      />
      {open && (
        <div className="trace-card__body">
          {preamble.systemPrompt && promptMatches && (
            <ContextFold
              open={contextPromptOpen}
              onToggle={onTogglePrompt}
              label="Prompt"
              detail={`${formatCharCount(preamble.systemPrompt.length)} chars`}
              tone="prompt"
            >
              <div className="flex justify-end mb-1">
                <CopyControl value={preamble.systemPrompt} ariaLabel="Copy prompt" />
              </div>
              <ExpandableText
                text={preamble.systemPrompt}
                className="trace-body-muted"
                previewChars={360}
              />
            </ContextFold>
          )}
          {tools.length > 0 && (
            <ContextFold
              open={contextToolsOpen}
              onToggle={onToggleTools}
              label="Tools"
              detail={
                q
                  ? `${tools.length} of ${preamble.tools.length}`
                  : String(preamble.tools.length)
              }
              tone="tools"
            >
              {tools.map((t) => (
                <ToolDef key={t.name} tool={t} />
              ))}
            </ContextFold>
          )}
        </div>
      )}
    </article>
  )
}
