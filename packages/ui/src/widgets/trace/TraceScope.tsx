/**
 * Scope header row + pin overlay (VS Code outline dialect).
 * In-flow rows and pinned clones share the same grid so chevrons line up.
 */

import { ChevronDown, ChevronRight } from "lucide-react"
import type { ReactNode } from "react"
import type { TraceScopeKind } from "./trace-pin"

export function ScopeRow({
  scopeId,
  kind,
  callIndex,
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
      className={`trace-scope${open ? " is-open" : ""}${soft ? " is-soft" : ""}`}
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

export type PinRow = {
  id: string
  kind: TraceScopeKind
  leading: string
  title: string
  summary: string
  soft: boolean
  open: boolean
}

export function PinOverlay({
  rows,
  onToggle,
  onReveal,
}: {
  rows: PinRow[]
  /** Chevron — expand/collapse only. */
  onToggle: (scopeId: string) => void
  /** Row body — navigate to that scope. */
  onReveal: (scopeId: string) => void
}) {
  if (rows.length === 0) return null
  return (
    <div className="trace-pin" role="navigation" aria-label="Sticky trace scopes">
      <div className="trace-pin__stack">
        {rows.map((row) => (
          <div
            key={row.id}
            className={`trace-scope is-pinned${row.open ? " is-open" : ""}${row.soft ? " is-soft" : ""}`}
            data-trace-kind={row.kind}
          >
            <button
              type="button"
              className="trace-scope__chevbtn"
              onClick={(e) => {
                e.stopPropagation()
                onToggle(row.id)
              }}
              aria-label={row.open ? "Collapse" : "Expand"}
              aria-expanded={row.open}
            >
              {row.open ? (
                <ChevronDown size={14} className="trace-scope__chev" />
              ) : (
                <ChevronRight size={14} className="trace-scope__chev" />
              )}
            </button>
            <button
              type="button"
              className="trace-scope__jump"
              onClick={() => onReveal(row.id)}
              title="Go to scope"
            >
              <span className="trace-scope__lead">{row.leading}</span>
              {row.title ? <span className="trace-scope__title">{row.title}</span> : null}
              {row.summary ? <span className="trace-scope__sum">{row.summary}</span> : null}
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
