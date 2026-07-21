/**
 * Scope headers — real in-flow rows; sticky via CSS (.trace-card / .trace-stick-block).
 */

import { ChevronDown, ChevronRight } from "lucide-react"
import type { ReactNode } from "react"
import type { TraceScopeKind } from "./trace-pin"

function ScopeLabel({
  leading,
  title,
  summary,
  trailing,
}: {
  leading: string
  title?: string
  summary?: string
  trailing?: ReactNode
}) {
  return (
    <>
      <span className="trace-scope__lead">{leading}</span>
      {title ? <span className="trace-scope__title">{title}</span> : null}
      {summary ? <span className="trace-scope__sum">{summary}</span> : null}
      {trailing ? <span className="trace-scope__trail">{trailing}</span> : null}
    </>
  )
}

function ScopeChevron({ open }: { open: boolean }) {
  return (
    <span className="trace-scope__chevslot" aria-hidden>
      {open ? (
        <ChevronDown size={14} className="trace-scope__chev" />
      ) : (
        <ChevronRight size={14} className="trace-scope__chev" />
      )}
    </span>
  )
}

export function ScopeRow({
  scopeId,
  kind,
  callIndex,
  depth = 0,
  open,
  onToggle,
  leading,
  title,
  summary,
  trailing,
  soft = false,
}: {
  scopeId: string
  kind: TraceScopeKind
  callIndex?: number | null
  depth?: number
  open: boolean
  onToggle: () => void
  leading: string
  title?: string
  summary?: string
  trailing?: ReactNode
  soft?: boolean
}) {
  return (
    <button
      type="button"
      data-trace-scope={scopeId}
      data-trace-kind={kind}
      data-trace-call={callIndex == null ? "" : String(callIndex)}
      data-trace-depth={String(depth)}
      className={`trace-scope${open ? " is-open" : ""}${soft ? " is-soft" : ""}`}
      onClick={onToggle}
      aria-expanded={open}
    >
      <ScopeChevron open={open} />
      <ScopeLabel
        leading={leading}
        title={title}
        summary={summary}
        trailing={trailing}
      />
    </button>
  )
}
