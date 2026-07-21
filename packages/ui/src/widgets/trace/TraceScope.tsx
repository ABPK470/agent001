/**
 * Scope headers + VS Code sticky-scroll pin overlay.
 *
 * In-flow rows are never position:sticky. A pin overlay clones the *same*
 * chrome (text, trail, colors, indent) for the ancestor chain of the
 * focus line — click line to jump, chevron to fold (editor dialect).
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

export type PinRow = {
  id: string
  kind: TraceScopeKind
  depth: number
  leading: string
  title: string
  summary: string
  soft: boolean
  open: boolean
  trailing?: ReactNode
}

/**
 * Sticky stack — identical visual dialect to ScopeRow.
 * Chevron folds; label navigates (VS Code sticky scroll).
 */
export function PinOverlay({
  rows,
  onToggle,
  onReveal,
}: {
  rows: PinRow[]
  onToggle: (scopeId: string) => void
  onReveal: (scopeId: string) => void
}) {
  if (rows.length === 0) return null
  return (
    <div className="trace-pin" role="navigation" aria-label="Sticky trace scopes">
      <div className="trace-pin__stack">
        {rows.map((row) => (
          <div
            key={row.id}
            className={`trace-scope${row.open ? " is-open" : ""}${row.soft ? " is-soft" : ""}`}
            data-trace-kind={row.kind}
            data-trace-depth={String(row.depth)}
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
              <ScopeLabel
                leading={row.leading}
                title={row.title || undefined}
                summary={row.summary || undefined}
                trailing={row.trailing}
              />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
