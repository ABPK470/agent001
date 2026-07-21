/**
 * Scope header row — real in-flow sticky (VS Code sticky scroll).
 * The same element sticks; nothing is cloned or restyled when pinned.
 */

import { ChevronDown, ChevronRight } from "lucide-react"
import type { ReactNode } from "react"
import { TRACE_STICKY_ROW_H, type TraceScopeKind } from "./trace-pin"

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
      style={{ top: depth * TRACE_STICKY_ROW_H }}
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
      <span className="trace-scope__lead">{leading}</span>
      {title ? <span className="trace-scope__title">{title}</span> : null}
      {summary ? <span className="trace-scope__sum">{summary}</span> : null}
      {trailing ? <span className="trace-scope__trail">{trailing}</span> : null}
    </button>
  )
}
