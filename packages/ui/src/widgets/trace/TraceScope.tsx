/**
 * Scope headers + Cursor/VS Code sticky-scroll pin band.
 *
 * In-flow rows are never position:sticky. A reserved pin band above the
 * scrollport clones the same chrome for the ancestor chain of the focus
 * line — click label to jump, chevron to fold (editor dialect). Content
 * never scrolls under the pins.
 */

import { ChevronDown, ChevronRight } from "lucide-react"
import { useRef, type ReactNode } from "react"
import { preserveScrollAnchor } from "../../lib/chatScroll"
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

function ScopeChevron({ open, expandable }: { open: boolean; expandable: boolean }) {
  return (
    <span className="trace-scope__chevslot" aria-hidden>
      {expandable ? (
        open ? (
          <ChevronDown size={14} className="trace-scope__chev" />
        ) : (
          <ChevronRight size={14} className="trace-scope__chev" />
        )
      ) : null}
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
  expandable = true,
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
  /** False when the body has nothing to show — no chevron, not a toggle. */
  expandable?: boolean
}) {
  const buttonRef = useRef<HTMLButtonElement>(null)
  const className = `trace-scope${open && expandable ? " is-open" : ""}${soft ? " is-soft" : ""}${
    expandable ? "" : " is-leaf"
  }`
  const label = (
    <ScopeLabel
      leading={leading}
      title={title}
      summary={summary}
      trailing={trailing}
    />
  )

  if (!expandable) {
    return (
      <div
        data-trace-scope={scopeId}
        data-trace-kind={kind}
        data-trace-call={callIndex == null ? "" : String(callIndex)}
        data-trace-depth={String(depth)}
        className={className}
        role="group"
      >
        <ScopeChevron open={false} expandable={false} />
        {label}
      </div>
    )
  }

  function onClick() {
    preserveScrollAnchor(buttonRef.current, onToggle)
  }

  return (
    <button
      ref={buttonRef}
      type="button"
      data-trace-scope={scopeId}
      data-trace-kind={kind}
      data-trace-call={callIndex == null ? "" : String(callIndex)}
      data-trace-depth={String(depth)}
      className={className}
      onClick={onClick}
      aria-expanded={open}
    >
      <ScopeChevron open={open} expandable />
      {label}
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
  foldable?: boolean
  trailing?: ReactNode
}

/**
 * Sticky stack — identical visual dialect to ScopeRow.
 * Lives in a reserved band above the scrollport (not an overlay).
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
        {rows.map((row) => {
          const foldable = row.foldable !== false
          return (
            <div
              key={row.id}
              className={`trace-scope${row.open ? " is-open" : ""}${row.soft ? " is-soft" : ""}${
                foldable ? "" : " is-root"
              }`}
              data-trace-kind={row.kind}
              data-trace-depth={String(row.depth)}
            >
              {foldable ? (
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
              ) : (
                <span className="trace-scope__chevslot" aria-hidden />
              )}
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
          )
        })}
      </div>
    </div>
  )
}
