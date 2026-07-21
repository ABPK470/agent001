/**
 * Outline scope header — in-flow row (never position:sticky).
 * Pin overlay clones the same chrome.
 */

import { ChevronDown, ChevronRight } from "lucide-react"
import { useRef, type ReactNode } from "react"
import { preserveScrollAnchor } from "../../lib/chatScroll"

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
      <span className="outline-scope__lead">{leading}</span>
      {title ? <span className="outline-scope__title">{title}</span> : null}
      {summary ? <span className="outline-scope__sum">{summary}</span> : null}
      {trailing ? <span className="outline-scope__trail">{trailing}</span> : null}
    </>
  )
}

function ScopeChevron({ open, expandable }: { open: boolean; expandable: boolean }) {
  return (
    <span className="outline-scope__chevslot" aria-hidden>
      {expandable ? (
        open ? (
          <ChevronDown size={14} className="outline-scope__chev" />
        ) : (
          <ChevronRight size={14} className="outline-scope__chev" />
        )
      ) : null}
    </span>
  )
}

export function OutlineScopeRow({
  scopeId,
  family,
  depth = 0,
  open,
  onToggle,
  leading,
  title,
  summary,
  trailing,
  soft = false,
  expandable = true,
  className = "",
}: {
  scopeId: string
  family: string
  depth?: number
  open: boolean
  onToggle: () => void
  leading: string
  title?: string
  summary?: string
  trailing?: ReactNode
  soft?: boolean
  expandable?: boolean
  className?: string
}) {
  const buttonRef = useRef<HTMLButtonElement>(null)
  const cn = `outline-scope${open && expandable ? " is-open" : ""}${soft ? " is-soft" : ""}${
    expandable ? "" : " is-leaf"
  }${className ? ` ${className}` : ""}`
  const label = (
    <ScopeLabel leading={leading} title={title} summary={summary} trailing={trailing} />
  )

  if (!expandable) {
    return (
      <div
        data-outline-scope={scopeId}
        data-outline-family={family}
        data-outline-depth={String(depth)}
        className={cn}
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
      data-outline-scope={scopeId}
      data-outline-family={family}
      data-outline-depth={String(depth)}
      className={cn}
      onClick={onClick}
      aria-expanded={open}
    >
      <ScopeChevron open={open} expandable />
      {label}
    </button>
  )
}
