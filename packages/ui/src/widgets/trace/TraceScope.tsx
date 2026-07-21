/**
 * Scope headers — in-flow rows inside Trace cards.
 * Leaf rows (no expandable body) keep the chevron slot for alignment but are not buttons.
 * Expand keeps the header where it is — body opens downward (preserveScrollAnchor).
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
